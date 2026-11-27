// The public sign-up actions of the `QaDriver`, only for SC-26 (docs/test-plan.md §4.1,
// docs/tool-catalog.md): the one fenced exception to "the driver never touches `Leads`" (ADR-0015 §6).
// Every action builds its mailbox from a `key` and asserts it before any read (signup-fence.ts):
//
//   signup.readCode  the first raw MIME under the `sim` route of the mail bucket written after `afterTs`
//                    whose `To` is exactly that mailbox: its 6-digit code, subject, detected language and
//                    the ADR-0014 word check over subject and body (never the MIME itself)
//   lead.inspect     only non-personal facts of the mailbox's lead and account (no name, company, job
//                    title, email or user name): consents, language, UTM, dates, mail status, notice
//                    status, the branch of its latest sign-up, the leased world and the counts by hash
//   lead.purge       the same module as `npm run leads:delete` (leads/delete.ts)
//   account.markAutomation  the server-side mark of an automation account on the mailbox's user
//                    (ADR-0021 §8): SC-26's sign-ins pass without an SMS no one could read; such an
//                    account never enrols a phone, so it never becomes a lead (only its draft exists)
//
// The word check reads the closed list of ADR-0014 from its single source (scripts/lint/neutral-words.ts).
import { ToolError } from "@legajo/shared";
import { findNeutralHits } from "../../../../scripts/lint/neutral-words";
import { readMailStatus } from "../channels/email/mail-status";
import { htmlToText } from "../channels/email/html-text";
import { parseMime } from "../channels/email/mime";
import type { TableClient } from "../connector/index";
import { type SecretKey, leadEmailHash } from "../lib/crypto";
import { type LeadDeleteDeps, deleteLead } from "../leads/delete";
import type { LeadStore } from "../leads/store";
import type { PhoneStore } from "../phone-verification/store";
import { detectLanguage } from "../services/language";
import type { SignupCognito } from "../signup/cognito";
import type { SignupStore } from "../signup/store";
import { readAccountWorld } from "../worlds/guest-slots";
import { QA_REASON } from "./contract";
import type { QaParsedInput } from "./contract-inputs";
import type { ActionContext } from "./ports";
import { assertSignupMailbox, signupMailbox } from "./signup-fence";

/** Raw MIME of the `sim` route of the mail bucket (`Resource.InboundMailSim`, read only). */
export interface AccountMailReader {
  /** Objects written at or after `since`, oldest first. */
  listSince(since: Date): Promise<ReadonlyArray<{ readonly key: string; readonly at: Date }>>;
  read(key: string): Promise<Uint8Array>;
}

export interface SignupActionDeps {
  readonly mail: AccountMailReader;
  /** `Runtime` (`MAILSTATUS#`, `GUESTWORLD#`) and `Leads`, through the connector's client. */
  readonly client: TableClient;
  readonly leads: Pick<LeadStore, "get" | "delete" | "putTombstone" | "getDraft" | "deleteDraft">;
  readonly phones: Pick<PhoneStore, "forgetAccount" | "markAutomation" | "getAccount">;
  readonly signups: Pick<SignupStore, "listPending" | "delete">;
  readonly cognito: Pick<SignupCognito, "findByEmail" | "deleteUser">;
  readonly invoker: LeadDeleteDeps["invoker"];
  /** `lead-email` subkey: the hash of `Leads/EMAIL#` and `MAILSTATUS#`. */
  readonly leadEmailKey: SecretKey;
}

/** How often `signup.readCode` lists the mailbox again. */
export const READ_CODE_POLL_MS = 5_000;

const CODE = /\b(\d{6})\b/;
const ADDRESS = /[^\s<>,;"']+@[^\s<>,;"']+/g;

/** Every address of the `To` headers, lower case. */
function recipientsOf(values: readonly string[]): string[] {
  return values.flatMap((value) => value.match(ADDRESS) ?? []).map((address) => address.toLowerCase());
}

export interface AccountMailRead {
  readonly code: string;
  readonly subject: string;
  readonly language: "es" | "en" | "und";
  /** ADR-0014 over subject and body: the groups hit, never the words themselves. */
  readonly neutral: { readonly clean: boolean; readonly groups: readonly number[] };
  readonly receivedAt: string;
}

async function accountMail(raw: Uint8Array, mailbox: string, at: Date): Promise<AccountMailRead | undefined> {
  const mail = await parseMime(raw);
  const recipients = recipientsOf(mail.header("to"));
  if (recipients.length !== 1 || recipients[0] !== mailbox) return undefined;
  const body = mail.text ?? (mail.html === undefined ? "" : htmlToText(mail.html));
  const code = CODE.exec(body)?.[1];
  if (code === undefined) return undefined;
  const hits = findNeutralHits(`${mail.subject}\n${body}`);
  return {
    code,
    subject: mail.subject,
    language: detectLanguage(`${mail.subject}\n${body}`).language,
    neutral: { clean: hits.length === 0, groups: [...new Set(hits.map((hit) => hit.group))].sort() },
    receivedAt: at.toISOString(),
  };
}

async function readCode(deps: SignupActionDeps, input: QaParsedInput<"signup.readCode">, ctx: ActionContext): Promise<AccountMailRead & { readonly kind: string }> {
  const mailbox = signupMailbox(ctx.idempotencyKey, input.key);
  assertSignupMailbox(mailbox, ctx.idempotencyKey);
  const since = new Date(input.afterTs);
  const seen = new Set<string>();
  const deadline = ctx.now().getTime() + input.timeoutSec * 1_000;
  for (;;) {
    for (const object of await deps.mail.listSince(since)) {
      if (seen.has(object.key)) continue;
      seen.add(object.key);
      const found = await accountMail(await deps.mail.read(object.key), mailbox, object.at);
      if (found !== undefined) return { kind: input.kind, ...found };
    }
    if (ctx.now().getTime() >= deadline) break;
    await ctx.sleep(READ_CODE_POLL_MS);
  }
  throw new ToolError("UNAVAILABLE", `no account email for sign-up key ${input.key} in ${input.timeoutSec} s`, QA_REASON.NO_ACCOUNT_MAIL);
}

function consentOf(consent: { readonly accepted: boolean; readonly at: string; readonly version: string; readonly lang: string }) {
  return { accepted: consent.accepted, at: consent.at, version: consent.version, lang: consent.lang };
}

async function inspectLead(deps: SignupActionDeps, input: QaParsedInput<"lead.inspect">, ctx: ActionContext) {
  const mailbox = signupMailbox(ctx.idempotencyKey, input.key);
  assertSignupMailbox(mailbox, ctx.idempotencyKey);
  const emailHash = leadEmailHash(deps.leadEmailKey, mailbox);
  const [lead, users, pending, mailStatus] = await Promise.all([deps.leads.get(emailHash), deps.cognito.findByEmail(mailbox), deps.signups.listPending(ctx.now()), readMailStatus(deps.client, emailHash)]);
  const latest = pending.filter((signup) => signup.emailHash === emailHash).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const leases = await Promise.all(users.flatMap((user) => (user.sub === undefined ? [] : [readAccountWorld(deps.client, user.sub)])));
  const lease = leases.find((candidate) => candidate?.firmId !== undefined);
  // Before the phone is verified the sign-up's lead is a draft (ADR-0021): the same facts, from it.
  const drafts = (await Promise.all(users.map((user) => deps.leads.getDraft(user.username, ctx.now())))).flatMap((draft) => (draft === undefined ? [] : [draft]));
  const phones = await Promise.all(users.flatMap((user) => (user.sub === undefined ? [] : [deps.phones.getAccount(user.sub)])));
  const source = lead ?? drafts[0];
  return {
    exists: lead !== undefined,
    leads: lead === undefined ? 0 : 1,
    drafts: drafts.length,
    users: users.length,
    phoneVerified: phones.some((phone) => phone?.verifiedAt !== undefined),
    automation: phones.some((phone) => phone?.automation !== undefined),
    ...(source === undefined
      ? {}
      : {
          consents: { terms: { ...consentOf(source.consents.terms), privacyVersion: source.consents.terms.privacyVersion }, contact: consentOf(source.consents.contact) },
          language: source.language,
          utm: source.utm,
          ...(source.referrer === undefined ? {} : { referrer: source.referrer }),
          signupAt: source.signupAt,
          confirmedAt: source.confirmedAt,
          /** Which optional fields the lead (or its draft) holds, never their values. */
          optionalFields: (["name", "company", "jobTitle"] as const).filter((field) => source[field] !== undefined),
        }),
    ...(lead === undefined ? {} : { noticeStatus: lead.noticeStatus, ...(lead.lastLoginAt === undefined ? {} : { lastLoginAt: lead.lastLoginAt }) }),
    emailStatus: mailStatus?.status ?? null,
    branch: latest?.branch ?? null,
    pendingVerified: latest?.verifiedAt !== undefined,
    world: lease === undefined ? null : { firmId: lease.firmId ?? null, state: lease.state },
  };
}

async function purgeLead(deps: SignupActionDeps, input: QaParsedInput<"lead.purge">, ctx: ActionContext) {
  const mailbox = signupMailbox(ctx.idempotencyKey, input.key);
  assertSignupMailbox(mailbox, ctx.idempotencyKey);
  const deletion = await deleteLead({ ...deps, now: ctx.now }, mailbox, "REQUEST");
  return { purged: deletion.leadId !== undefined || deletion.users > 0, users: deletion.users, worldsDestroyed: deletion.worldsDestroyed };
}

async function markAutomation(deps: SignupActionDeps, input: QaParsedInput<"account.markAutomation">, ctx: ActionContext) {
  const mailbox = signupMailbox(ctx.idempotencyKey, input.key);
  assertSignupMailbox(mailbox, ctx.idempotencyKey);
  const users = (await deps.cognito.findByEmail(mailbox)).filter((user) => user.sub !== undefined);
  for (const user of users) await deps.phones.markAutomation(user.sub ?? "", "QA_SIGNUP", ctx.now());
  return { marked: users.length };
}

/** The four actions over their ports (built on first use: a run without SC-26 never reaches them). */
export function signupActions(deps: () => SignupActionDeps) {
  return {
    "signup.readCode": (input: QaParsedInput<"signup.readCode">, ctx: ActionContext) => readCode(deps(), input, ctx),
    "lead.inspect": (input: QaParsedInput<"lead.inspect">, ctx: ActionContext) => inspectLead(deps(), input, ctx),
    "lead.purge": (input: QaParsedInput<"lead.purge">, ctx: ActionContext) => purgeLead(deps(), input, ctx),
    "account.markAutomation": (input: QaParsedInput<"account.markAutomation">, ctx: ActionContext) => markAutomation(deps(), input, ctx),
  };
}
