// The lead items of `Leads` (leads/lead.ts) over the connector's TableClient: the only module that
// reads or writes `EMAIL#…/LEAD` and `DELETED#…`. `finalizeSignup` creates a lead (and is the only
// caller of `saveVerifiedLead`), `account.session` moves `lastLoginAt`, `LeadNotice` records
// `noticeStatus`, the sweep and the operator's scripts list, withdraw and delete. Nothing here logs
// or returns an email to a caller that does not already hold it.
import { ConnectorError } from "@legajo/shared";
import type { Item, TableClient } from "../connector/index";
import { LEADS_TABLE, Lead, type LeadConsents, type NoticeStatus, SOURCE_POC, type Tombstone, leadKey, tombKey } from "./lead";

/** What `finalizeSignup` knows about a verified sign-up. */
export interface VerifiedLeadInput {
  readonly newLeadId: string;
  readonly email: string;
  readonly emailHash: string;
  readonly name?: string;
  readonly company?: string;
  readonly jobTitle?: string;
  readonly consents: LeadConsents;
  readonly language: Lead["language"];
  readonly utm: Lead["utm"];
  readonly referrer?: string;
  readonly signupAt: string;
  readonly confirmedAt: string;
  readonly cognitoUsername: string;
}

export interface LeadStore {
  get(emailHash: string): Promise<Lead | undefined>;
  /**
   * Creates the lead, or merges a new verified sign-up of the same email into it: optional data that
   * came in, both consents with their date and version (the previous ones go to `consentHistory`).
   * Conditional on the version it read; a lost race reads again. Returns the stored lead and whether
   * it was new.
   */
  saveVerifiedLead(input: VerifiedLeadInput, now: Date): Promise<{ readonly lead: Lead; readonly created: boolean }>;
  setNotice(emailHash: string, status: NoticeStatus, attempts: number, now: Date): Promise<void>;
  /** `lastLoginAt` = `at` only when it is later than the stored one. */
  touchLastLogin(emailHash: string, at: string, now: Date): Promise<boolean>;
  /** Contact consent → false, with the change in `consentHistory`. */
  optOutContact(emailHash: string, at: string, now: Date): Promise<Lead | undefined>;
  delete(emailHash: string): Promise<void>;
  putTombstone(tomb: Tombstone, now: Date): Promise<void>;
  /** Every lead (exports, notice retries, retention): the table is small and has no index. */
  listLeads(): Promise<Lead[]>;
}

function parseLead(item: Item | undefined): Lead | undefined {
  if (item === undefined) return undefined;
  const parsed = Lead.safeParse(item);
  if (!parsed.success) throw new ConnectorError("VALIDATION", "a lead row does not match its schema", "Leads");
  return parsed.data;
}

function optional<T>(name: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [name]: value };
}

const MERGE_ATTEMPTS = 3;

export function createLeadStore(client: TableClient): LeadStore {
  async function get(emailHash: string): Promise<Lead | undefined> {
    return parseLead(await client.get(LEADS_TABLE, leadKey(emailHash)));
  }

  async function create(input: VerifiedLeadInput, now: Date): Promise<Lead> {
    const item = {
      ...leadKey(input.emailHash),
      entity: "Lead",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 1,
      leadId: input.newLeadId,
      email: input.email,
      emailHash: input.emailHash,
      ...optional("name", input.name),
      ...optional("company", input.company),
      ...optional("jobTitle", input.jobTitle),
      consents: input.consents,
      consentHistory: [],
      sourcePoc: SOURCE_POC,
      language: input.language,
      utm: input.utm,
      ...optional("referrer", input.referrer),
      signupAt: input.signupAt,
      confirmedAt: input.confirmedAt,
      cognitoUsername: input.cognitoUsername,
      noticeStatus: "PENDING",
      noticeAttempts: 0,
    };
    Lead.parse(item);
    await client.put(LEADS_TABLE, item, { ifNotExists: true });
    return Lead.parse(item);
  }

  async function merge(existing: Lead, input: VerifiedLeadInput, now: Date): Promise<Lead> {
    const changes = (["terms", "contact"] as const).map((consent) => ({ consent, ...existing.consents[consent] }));
    const stored = await client.update(
      LEADS_TABLE,
      leadKey(input.emailHash),
      {
        set: {
          ...optional("name", input.name),
          ...optional("company", input.company),
          ...optional("jobTitle", input.jobTitle),
          consents: input.consents,
          language: input.language,
          confirmedAt: input.confirmedAt,
          cognitoUsername: input.cognitoUsername,
          ...(Object.keys(input.utm).length > 0 ? { utm: input.utm } : {}),
          ...optional("referrer", input.referrer),
        },
        append: { consentHistory: changes },
      },
      now.toISOString(),
      { condition: { ifVersion: existing.version } },
    );
    return Lead.parse(stored);
  }

  return {
    get,

    async saveVerifiedLead(input, now) {
      for (let attempt = 1; ; attempt += 1) {
        const existing = await get(input.emailHash);
        try {
          return existing === undefined ? { lead: await create(input, now), created: true } : { lead: await merge(existing, input, now), created: false };
        } catch (error) {
          if (!(error instanceof ConnectorError && error.code === "CONFLICT") || attempt >= MERGE_ATTEMPTS) throw error;
        }
      }
    },

    async setNotice(emailHash, status, attempts, now) {
      await client.update(LEADS_TABLE, leadKey(emailHash), { set: { noticeStatus: status, noticeAttempts: attempts } }, now.toISOString());
    },

    async touchLastLogin(emailHash, at, now) {
      const lead = await get(emailHash);
      if (lead === undefined || (lead.lastLoginAt !== undefined && Date.parse(lead.lastLoginAt) >= Date.parse(at))) return false;
      try {
        await client.update(LEADS_TABLE, leadKey(emailHash), { set: { lastLoginAt: at } }, now.toISOString(), { condition: { ifVersion: lead.version } });
        return true;
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
        throw error;
      }
    },

    async optOutContact(emailHash, at, now) {
      const lead = await get(emailHash);
      if (lead === undefined) return undefined;
      const withdrawn = { ...lead.consents.contact, accepted: false, at };
      const stored = await client.update(
        LEADS_TABLE,
        leadKey(emailHash),
        { set: { consents: { ...lead.consents, contact: withdrawn } }, append: { consentHistory: [{ consent: "contact", ...withdrawn }] } },
        now.toISOString(),
        { condition: { ifVersion: lead.version } },
      );
      return Lead.parse(stored);
    },

    async delete(emailHash) {
      await client.delete(LEADS_TABLE, leadKey(emailHash));
    },

    async putTombstone(tomb, now) {
      await client.put(LEADS_TABLE, { ...tombKey(tomb.leadId), entity: "LeadTombstone", createdAt: now.toISOString(), updatedAt: now.toISOString(), version: 1, ...tomb });
    },

    async listLeads() {
      const rows = await client.scan(LEADS_TABLE, { filter: { equals: { entity: "Lead" } } });
      return rows.map((row) => Lead.parse(row));
    },
  };
}
