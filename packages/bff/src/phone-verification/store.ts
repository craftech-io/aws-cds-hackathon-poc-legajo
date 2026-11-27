// The phone items of `Leads` (records.ts) over the connector's TableClient: the only module that reads
// or writes `PHONE#…` and `PHONENUM#…`. Nothing here logs a number or a code.
import { ConnectorError } from "@legajo/shared";
import { PHONE_SESSION_TTL_SECONDS } from "@legajo/shared/guest-limits";
import type { Item, TableClient } from "../connector/index";
import { LEADS_TABLE } from "../leads/lead";
import {
  AccountPhoneRecord,
  type AutomationReason,
  PhoneCodeRecord,
  PhoneOwnerRecord,
  PhoneSessionRecord,
  accountPhoneKey,
  phoneCodeKey,
  phoneOwnerKey,
  phoneSessionKey,
} from "./records";

export type NewPhoneCode = Omit<PhoneCodeRecord, "version" | "attempts">;

export interface PhoneStore {
  getAccount(sub: string): Promise<AccountPhoneRecord | undefined>;
  /** The code in flight, while its ten minutes last. */
  getCode(sub: string, now: Date): Promise<PhoneCodeRecord | undefined>;
  /** Writes a new code over `previous` (by version) or where none was: false when another send won. */
  putCode(code: NewPhoneCode, previous: PhoneCodeRecord | undefined, now: Date): Promise<boolean>;
  /** One more wrong try, only while fewer than `max` were counted: the new count, or `undefined` once closed. */
  countWrongTry(sub: string, max: number, now: Date): Promise<number | undefined>;
  deleteCode(sub: string): Promise<void>;
  /** The account a verified number belongs to. */
  ownerOf(phoneHash: string): Promise<string | undefined>;
  /** Binds the number to `sub` unless another account holds it: true when it is (now) `sub`'s. */
  claimNumber(phoneHash: string, sub: string, now: Date): Promise<boolean>;
  setVerified(sub: string, phone: string, phoneHash: string, now: Date): Promise<void>;
  markSession(sub: string, sessionId: string, now: Date): Promise<void>;
  isSessionCleared(sub: string, sessionId: string, now: Date): Promise<boolean>;
  endSession(sub: string, sessionId: string): Promise<void>;
  /** The operator's or the fenced QaDriver's mark of an automation account. */
  markAutomation(sub: string, reason: AutomationReason, now: Date): Promise<void>;
  /** The operator's block of the account (scripts/console/block.ts), set or lifted; nothing else changes. */
  setBlocked(sub: string, blocked: boolean, now: Date): Promise<void>;
  /** Every session mark and the code in flight of the account: how many items went away. */
  endAllSessions(sub: string): Promise<number>;
  /** Every phone item of the account and the index of its number (leads:delete, retention). */
  forgetAccount(sub: string): Promise<void>;
}

const epoch = (date: Date): number => Math.floor(date.getTime() / 1000);

function parsed<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, row: Item | undefined, what: string): T | undefined {
  if (row === undefined) return undefined;
  const result = schema.safeParse(row);
  if (!result.success) throw new ConnectorError("VALIDATION", `${what} does not match its schema`, "Leads");
  return result.data;
}

function isConflict(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}

export function createPhoneStore(client: TableClient): PhoneStore {
  const stamp = (now: Date, entity: string) => ({ entity, createdAt: now.toISOString(), updatedAt: now.toISOString(), version: 1 });

  async function getAccount(sub: string): Promise<AccountPhoneRecord | undefined> {
    return parsed(AccountPhoneRecord, await client.get(LEADS_TABLE, accountPhoneKey(sub)), "a phone account");
  }

  async function ownerOf(phoneHash: string): Promise<string | undefined> {
    return parsed(PhoneOwnerRecord, await client.get(LEADS_TABLE, phoneOwnerKey(phoneHash)), "a phone owner")?.sub;
  }

  return {
    getAccount,
    ownerOf,

    async getCode(sub, now) {
      const code = parsed(PhoneCodeRecord, await client.get(LEADS_TABLE, phoneCodeKey(sub)), "a phone code");
      return code !== undefined && code.codeExpiresAt > epoch(now) ? code : undefined;
    },

    async putCode(code, previous, now) {
      const item = { ...phoneCodeKey(code.sub), ...stamp(now, "PhoneCode"), ...code, attempts: 0, version: (previous?.version ?? 0) + 1 };
      PhoneCodeRecord.parse(item);
      try {
        // An expired code still in the table (TTL is lazy) is replaced like an absent one.
        await client.put(LEADS_TABLE, item, previous === undefined ? { ifAbsentOrExpiredAt: epoch(now) } : { equals: { version: previous.version } });
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },

    async countWrongTry(sub, max, now) {
      try {
        const stored = await client.update(LEADS_TABLE, phoneCodeKey(sub), { add: { attempts: 1 } }, now.toISOString(), { condition: { atMost: { attribute: "attempts", value: max - 1 } } });
        return PhoneCodeRecord.parse(stored).attempts;
      } catch (error) {
        if (isConflict(error) || (error instanceof ConnectorError && error.code === "NOT_FOUND")) return undefined;
        throw error;
      }
    },

    async deleteCode(sub) {
      await client.delete(LEADS_TABLE, phoneCodeKey(sub));
    },

    async claimNumber(phoneHash, sub, now) {
      try {
        await client.put(LEADS_TABLE, { ...phoneOwnerKey(phoneHash), ...stamp(now, "PhoneOwner"), sub, at: now.toISOString() }, { ifNotExists: true });
        return true;
      } catch (error) {
        if (!isConflict(error)) throw error;
        return (await ownerOf(phoneHash)) === sub;
      }
    },

    async setVerified(sub, phone, phoneHash, now) {
      await client.update(
        LEADS_TABLE,
        accountPhoneKey(sub),
        { set: { phone, phoneHash, verifiedAt: now.toISOString() }, setIfAbsent: { entity: "AccountPhone", sub, createdAt: now.toISOString() } },
        now.toISOString(),
        // The number of an account is written once; changing it is the operator's (docs/architecture.md §17).
        { upsert: true, condition: { absent: ["verifiedAt"] } },
      );
    },

    async markSession(sub, sessionId, now) {
      await client.put(LEADS_TABLE, { ...phoneSessionKey(sub, sessionId), ...stamp(now, "PhoneSession"), sub, sessionId, verifiedAt: now.toISOString(), expiresAt: epoch(now) + PHONE_SESSION_TTL_SECONDS });
    },

    async isSessionCleared(sub, sessionId, now) {
      const session = parsed(PhoneSessionRecord, await client.get(LEADS_TABLE, phoneSessionKey(sub, sessionId)), "a phone session");
      return session !== undefined && session.expiresAt > epoch(now);
    },

    async endSession(sub, sessionId) {
      await client.delete(LEADS_TABLE, phoneSessionKey(sub, sessionId));
    },

    async forgetAccount(sub) {
      const account = await getAccount(sub);
      if (account?.phoneHash !== undefined && (await ownerOf(account.phoneHash)) === sub) await client.delete(LEADS_TABLE, phoneOwnerKey(account.phoneHash));
      const rows = await client.query(LEADS_TABLE, { hashValue: accountPhoneKey(sub).PK });
      for (const row of rows) await client.delete(LEADS_TABLE, { PK: String(row.PK), SK: String(row.SK) });
    },

    async setBlocked(sub, blocked, now) {
      const existing = await client.get(LEADS_TABLE, accountPhoneKey(sub));
      const kept: Record<string, unknown> = { ...existing };
      delete kept.blockedAt;
      const version = typeof existing?.version === "number" ? existing.version : 0;
      const item = { ...accountPhoneKey(sub), ...stamp(now, "AccountPhone"), ...kept, sub, ...(blocked ? { blockedAt: now.toISOString() } : {}), updatedAt: now.toISOString(), version: version + 1 };
      AccountPhoneRecord.parse(item);
      // Pinned to the version read: a verification or a mark written in between makes the operator retry.
      await client.put(LEADS_TABLE, item, existing === undefined ? { ifNotExists: true } : { equals: { version } });
    },

    async endAllSessions(sub) {
      const rows = await client.query(LEADS_TABLE, { hashValue: accountPhoneKey(sub).PK });
      const gone = rows.filter((row) => String(row.SK) === phoneCodeKey(sub).SK || String(row.SK).startsWith("SESSION#"));
      for (const row of gone) await client.delete(LEADS_TABLE, { PK: String(row.PK), SK: String(row.SK) });
      return gone.length;
    },

    async markAutomation(sub, reason, now) {
      // A put, not an update: the fenced QaDriver may only put and delete in `Leads` (infra/leads-spec.ts).
      const existing = await client.get(LEADS_TABLE, accountPhoneKey(sub));
      const version = typeof existing?.version === "number" ? existing.version + 1 : 1;
      await client.put(LEADS_TABLE, { ...accountPhoneKey(sub), ...stamp(now, "AccountPhone"), ...existing, sub, automation: reason, updatedAt: now.toISOString(), version });
    },
  };
}
