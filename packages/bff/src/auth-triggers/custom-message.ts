// Cognito custom message trigger `AuthCustomMessage` (ADR-0015 §3.2 and §7,
// docs/architecture-integrations.md §8): writes every account email in the user's language (`locale`,
// else `ClientMetadata.lang`) from auth-triggers/messages/, and keeps the account emails from becoming
// a way to mail third parties or to hurt the account's SES reputation:
//
//   per recipient 5 a day · per domain 60 an hour · 400 a day in total (guest-limits.ts)
//   never to a recipient with `Runtime/MAILSTATUS#` BOUNCED or COMPLAINED
//   nothing but operator invitations while `Runtime/MAILBREAKER` is open
//
// "Cutting" = the trigger fails and Cognito sends nothing. `CustomMessage_SignUp` only counts and cuts
// only for a bounce status or the breaker (`SignupDispatch` already checked the quotas before
// `SignUp`); `CustomMessage_AdminCreateUser` counts and never cuts. It never reads or writes `Leads`.
import { z } from "zod";
import { ACCOUNT_EMAIL_LIMITS } from "@legajo/shared/guest-limits";
import { countMetric } from "../channels/adapter";
import { MAIL_TOTAL_BASE, isBreakerOpen, readMailStatus } from "../channels/email/mail-status";
import { type TableClient, tableClient } from "../connector/index";
import { type SecretKey, leadEmailHash } from "../lib/crypto";
import { createLogger, type Logger } from "../lib/log";
import { subkey } from "../lib/secrets";
import { consumeWindowed, countWindowed } from "../signup/counters";
import { domainHash as hashDomain } from "../signup/dispatch";
import { type AccountEmailKind, type EmailLang, accountEmail } from "./messages/index";

const StringMap = z.record(z.string(), z.string());

export const CustomMessageEvent = z.looseObject({
  triggerSource: z.string().min(1),
  request: z.looseObject({
    userAttributes: StringMap,
    codeParameter: z.string().min(1).nullish(),
    usernameParameter: z.string().min(1).nullish(),
    clientMetadata: StringMap.nullish(),
  }),
  response: z.unknown().optional(),
});
export type CustomMessageEvent = z.infer<typeof CustomMessageEvent>;

export const ACCOUNT_MAIL_METRICS = { blocked: "AccountMailBlocked" } as const;

/** Account email counters of `Runtime` (`RL#MAIL#…`); the total is the one the breaker reads. */
export const MAIL_BASES = {
  recipient: (emailHash: string) => `RL#MAIL#RCPT#${emailHash}`,
  domain: (domainHash: string) => `RL#MAIL#DOMAIN#${domainHash}`,
  total: MAIL_TOTAL_BASE,
} as const;

type Policy = "NEVER_CUT" | "COUNT_ONLY" | "CAPPED";

const SOURCES: Readonly<Record<string, { readonly kind: AccountEmailKind; readonly policy: Policy }>> = {
  CustomMessage_SignUp: { kind: "SIGNUP_CODE", policy: "COUNT_ONLY" },
  CustomMessage_ResendCode: { kind: "SIGNUP_CODE", policy: "CAPPED" },
  CustomMessage_ForgotPassword: { kind: "FORGOT_PASSWORD", policy: "CAPPED" },
  CustomMessage_UpdateUserAttribute: { kind: "VERIFY_EMAIL", policy: "CAPPED" },
  CustomMessage_VerifyUserAttribute: { kind: "VERIFY_EMAIL", policy: "CAPPED" },
  CustomMessage_AdminCreateUser: { kind: "INVITATION", policy: "NEVER_CUT" },
};

export interface CustomMessageDeps {
  readonly client: TableClient;
  readonly leadEmailKey: () => SecretKey;
  readonly rateKey: () => SecretKey;
  readonly now: () => Date;
  readonly log: Logger;
}

export type MailCut = "UNKNOWN_SOURCE" | "NO_RECIPIENT" | "MAIL_STATUS" | "BREAKER_OPEN" | "RECIPIENT_QUOTA" | "DOMAIN_QUOTA" | "TOTAL_QUOTA";

function languageOf(event: CustomMessageEvent): EmailLang {
  const wanted = event.request.userAttributes.locale ?? event.request.clientMetadata?.lang;
  return wanted === "en" ? "en" : "es";
}

function kindOf(event: CustomMessageEvent, base: AccountEmailKind): AccountEmailKind {
  return base === "FORGOT_PASSWORD" && event.request.clientMetadata?.intent === "signup-existing" ? "EXISTING_ACCOUNT" : base;
}

async function count(deps: CustomMessageDeps, emailHash: string, domainHash: string, policy: Policy, now: Date): Promise<MailCut | undefined> {
  if (policy !== "CAPPED") {
    await countWindowed(deps.client, MAIL_BASES.recipient(emailHash), "DAY", now);
    await countWindowed(deps.client, MAIL_BASES.domain(domainHash), "HOUR", now);
    await countWindowed(deps.client, MAIL_BASES.total, "DAY", now);
    return undefined;
  }
  const groups = [
    { base: MAIL_BASES.recipient(emailHash), limits: ACCOUNT_EMAIL_LIMITS.perRecipient, cut: "RECIPIENT_QUOTA" as const },
    { base: MAIL_BASES.domain(domainHash), limits: ACCOUNT_EMAIL_LIMITS.perDomain, cut: "DOMAIN_QUOTA" as const },
    { base: MAIL_BASES.total, limits: ACCOUNT_EMAIL_LIMITS.total, cut: "TOTAL_QUOTA" as const },
  ];
  for (const group of groups) {
    const outcome = await consumeWindowed(deps.client, [group], now, { explain: false });
    if (!outcome.ok) return group.cut;
  }
  return undefined;
}

/** `undefined`: send; otherwise why Cognito must send nothing. */
export async function decideMail(deps: CustomMessageDeps, event: CustomMessageEvent): Promise<MailCut | undefined> {
  const source = SOURCES[event.triggerSource];
  if (source === undefined) return "UNKNOWN_SOURCE";
  const email = event.request.userAttributes.email;
  const now = deps.now();
  if (email === undefined) return source.policy === "NEVER_CUT" ? undefined : "NO_RECIPIENT";
  const emailHash = leadEmailHash(deps.leadEmailKey(), email);
  const domainHash = hashDomain(deps.rateKey(), email);
  if (source.policy !== "NEVER_CUT") {
    if ((await readMailStatus(deps.client, emailHash)) !== undefined) return "MAIL_STATUS";
    if (await isBreakerOpen(deps.client)) return "BREAKER_OPEN";
  }
  return count(deps, emailHash, domainHash, source.policy, now);
}

export type CustomMessageHandler = (event: unknown) => Promise<unknown>;

export function createCustomMessageHandler(resolveDeps: () => CustomMessageDeps): CustomMessageHandler {
  return async (raw) => {
    const deps = resolveDeps();
    const parsed = CustomMessageEvent.safeParse(raw);
    if (!parsed.success) {
      deps.log.error("auth.custom_message.invalid_event", { issues: parsed.error.issues.length });
      throw new Error("the account email was not sent");
    }
    const event = parsed.data;
    const cut = await decideMail(deps, event);
    if (cut !== undefined) {
      countMetric(deps.log, ACCOUNT_MAIL_METRICS.blocked, { triggerSource: event.triggerSource, reason: cut });
      throw new Error("the account email was not sent");
    }
    const source = SOURCES[event.triggerSource];
    const kind = kindOf(event, source?.kind ?? "VERIFY_EMAIL");
    const code = event.request.codeParameter ?? undefined;
    const username = event.request.usernameParameter ?? undefined;
    const email = accountEmail(kind, languageOf(event), { code: code ?? "{####}", ...(username === undefined ? {} : { username }) });
    deps.log.info("auth.custom_message.written", { triggerSource: event.triggerSource, kind });
    return { ...event, response: { ...(typeof event.response === "object" && event.response !== null ? event.response : {}), emailSubject: email.subject, emailMessage: email.message } };
  };
}

export const handler: CustomMessageHandler = createCustomMessageHandler(() => ({
  client: tableClient(),
  leadEmailKey: () => subkey("lead-email"),
  rateKey: () => subkey("rate"),
  now: () => new Date(),
  log: createLogger({ bindings: { service: "auth-custom-message" } }),
}));
