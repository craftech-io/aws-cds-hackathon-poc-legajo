// What `SignupDispatch` checks before mailing a code (ADR-0015 §3.1 and §3.2), after `signup.start`
// already answered `CODE_SENT`: a bot that fills the honeypot, sends the form too fast or too late, or
// writes a domain that cannot receive mail (or a disposable mailbox) learns nothing, and nobody gets a
// code. Every check here is a reason to suppress (`SignupRejected {reason}`), never an error the visitor sees.
import { Resolver } from "node:dns/promises";
import { SES_MAILBOX_SIMULATOR_DOMAIN, SIM_MAIL_DOMAIN, STAGE_DOMAIN, isReservedDomain } from "@legajo/shared";
import { SIGNUP_FORM_MAX_SECONDS, SIGNUP_FORM_MIN_SECONDS, SIGNUP_MX_TIMEOUT_MS } from "@legajo/shared/guest-limits";
import type { SignupRejectReason } from "@legajo/shared/signup";
import { withDeadline } from "../lib/deadline";
import { isDisposableDomain, isDisposableExchanger } from "./disposable-domains";
import type { PendingSignup } from "../leads/lead";

export type Suppression = Extract<SignupRejectReason, "HONEYPOT" | "TOO_FAST" | "TOO_SLOW" | "FORM_TOKEN" | "RESERVED_DOMAIN" | "OWN_DOMAIN" | "DISPOSABLE_DOMAIN" | "NO_MX">;

/** Honeypot filled, a form token that is not ours, or a form sent outside the 3 s – 2 h of a person. */
export function formSuppression(signup: Pick<PendingSignup, "honeypot" | "formShownAt" | "startedAt">): Suppression | undefined {
  if (signup.honeypot) return "HONEYPOT";
  if (signup.formShownAt === undefined) return "FORM_TOKEN";
  const elapsed = (Date.parse(signup.startedAt) - Date.parse(signup.formShownAt)) / 1000;
  if (elapsed < SIGNUP_FORM_MIN_SECONDS) return "TOO_FAST";
  if (elapsed > SIGNUP_FORM_MAX_SECONDS) return "TOO_SLOW";
  return undefined;
}

// Special-use names that never receive mail (RFC 6761, RFC 7686, RFC 8375, ICANN `internal`) and the
// placeholder `test.com` people type to try a form, on top of the reserved ones of @legajo/shared.
const SPECIAL_USE_TLDS = ["local", "onion", "internal"];
const SPECIAL_USE_DOMAINS = ["home.arpa", "test.com"];

function within(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/** The `QaDriver`'s fenced mailbox of `SC-26`: `qa-signup-<runId>-<key>@sim.legajo.demo.craftech.io`. */
export const QA_SIGNUP_MAILBOX = /^qa-signup-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+$/;

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase().replace(/\.$/, "");
}

/** Reserved or special-use domains, our own (but for the fenced QA mailbox) and disposable mailboxes. */
export function domainSuppression(email: string): Extract<Suppression, "RESERVED_DOMAIN" | "OWN_DOMAIN" | "DISPOSABLE_DOMAIN"> | undefined {
  const domain = domainOf(email);
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (isReservedDomain(domain) || SPECIAL_USE_TLDS.includes(tld) || SPECIAL_USE_DOMAINS.some((name) => within(domain, name))) return "RESERVED_DOMAIN";
  if (domain === SIM_MAIL_DOMAIN && QA_SIGNUP_MAILBOX.test(email.slice(0, email.lastIndexOf("@")))) return undefined;
  if (within(domain, STAGE_DOMAIN) || within(domain, SES_MAILBOX_SIMULATOR_DOMAIN)) return "OWN_DOMAIN";
  if (isDisposableDomain(domain)) return "DISPOSABLE_DOMAIN";
  return undefined;
}

export interface MxRecord {
  readonly exchange: string;
  readonly priority: number;
}

export type MxResolver = (domain: string) => Promise<readonly MxRecord[]>;

/** One try with the same short deadline as `checkMx`, so a slow resolver never keeps the lookup alive. */
export const systemMxResolver: MxResolver = (domain) => new Resolver({ timeout: SIGNUP_MX_TIMEOUT_MS, tries: 1 }).resolveMx(domain);

/** A domain that answers no MX, or only the null MX of RFC 7505 (`.`), cannot receive mail. */
const NO_MAIL_CODES = new Set(["ENOTFOUND", "ENODATA"]);

export type MxVerdict = { readonly status: "OK" } | { readonly status: "NO_MX" } | { readonly status: "DISPOSABLE" } | { readonly status: "UNKNOWN" };

/**
 * MX lookup with its own deadline (2 s): `ENOTFOUND`/`ENODATA` or only a null MX suppress, and so does a
 * domain with any MX of a disposable-mailbox provider (`DISPOSABLE`); a resolver error
 * (`ETIMEOUT`, `ESERVFAIL`, `ECONNREFUSED`, the deadline) lets the sign-up through (`SignupMxUnknown`).
 */
export async function checkMx(domain: string, resolve: MxResolver, timeoutMs: number = SIGNUP_MX_TIMEOUT_MS): Promise<MxVerdict> {
  try {
    const records = await withDeadline("signup MX lookup", timeoutMs, () => resolve(domain));
    const usable = records.filter((record) => record.exchange !== "" && record.exchange !== ".");
    if (usable.length === 0) return { status: "NO_MX" };
    return isDisposableExchanger(usable.map((record) => record.exchange)) ? { status: "DISPOSABLE" } : { status: "OK" };
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    return typeof code === "string" && NO_MAIL_CODES.has(code) ? { status: "NO_MX" } : { status: "UNKNOWN" };
  }
}
