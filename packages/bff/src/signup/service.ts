// The four `signup.*` procedures (ADR-0015 §1 to §3; docs/tool-catalog.md "Alta pública"), without
// tRPC: routers/signup.ts calls them after the edge checks (origin, no batch, viewer IP).
//
//   form     the signed `formToken` (when the form was shown)
//   start    IP limit → breaker → total capacity → `SIGNUP#` (sealed password) → SignupDispatch START;
//            the same work and the same `CODE_SENT` whatever the email is (§1.1). No call to Cognito.
//   resend   60 s apart, 3 per sign-up → SignupDispatch RESEND. No call to Cognito.
//   confirm  by the recorded branch: ConfirmSignUp | ConfirmForgotPassword | nothing; `verifiedAt`
//            right after Cognito's success, then `finalizeSignup`. Every answer that is not CONFIRMED
//            leaves 1.5 s after the request started.
import { ToolError } from "@legajo/shared";
import { CONFIRM_MAX_ATTEMPTS, NON_CONFIRMED_RESPONSE_MS, RESEND_MAX_PER_SIGNUP, RESEND_WAIT_SECONDS } from "@legajo/shared/guest-limits";
import {
  type SignupConfirmOutput,
  type SignupFormOutput,
  type SignupResendOutput,
  type SignupStartOutput,
  type SignupStartRequest,
  sanitizeReferrer,
  sanitizeUtm,
} from "@legajo/shared/signup";
import { countMetric } from "../channels/adapter";
import { isBreakerOpen } from "../channels/email/mail-status";
import { leadEmailHash, sealSecret } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { PendingSignup } from "../leads/lead";
import type { AccessDeps } from "./deps";
import { SIGNUP_METRICS, sealContext } from "./dispatch";
import { finalizeSignup } from "./finalize";
import { gateConfirm, gateStart } from "./rate-limits";
import { formShownAt, issueFormToken } from "./ticket";

export interface SignupRequestContext {
  /** HMAC of the viewer's aggregated IP (lib/viewer-ip.ts); a request without one never reaches here. */
  readonly ipHash: string;
  readonly log: Logger;
}

function sameVersions(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  return a.terms === b.terms && a.privacy === b.privacy && a.contact === b.contact;
}

function rejected(log: Logger, reason: string): void {
  countMetric(log, SIGNUP_METRICS.rejected, { reason });
}

export function signupForm(deps: Pick<AccessDeps, "keys" | "now">, lang: "es" | "en"): SignupFormOutput {
  return { formToken: issueFormToken(deps.keys.form, lang, deps.now()) };
}

async function queueDispatch(deps: Pick<AccessDeps, "invoker" | "signups" | "now">, signup: Pick<PendingSignup, "signupId">, kind: "START" | "RESEND", dispatchSeq: number, log: Logger): Promise<void> {
  try {
    await deps.invoker.invoke("SignupDispatch", { kind, signupId: signup.signupId, dispatchSeq });
  } catch (error) {
    // The visitor still gets CODE_SENT; "Reenviar código" dispatches again.
    countMetric(log, SIGNUP_METRICS.dispatchFailed, { kind, stage: "INVOKE", error: error instanceof Error ? error.name : "unknown" });
    await deps.signups.setBranch(signup.signupId, dispatchSeq, "FAILED", deps.now());
  }
}

export async function signupStart(deps: AccessDeps, input: SignupStartRequest, ctx: SignupRequestContext): Promise<SignupStartOutput> {
  if (!sameVersions(input.consentVersions, deps.legalVersions)) throw new ToolError("INVALID", "the form shows texts that are no longer in force: reload the page", "CONSENT_VERSIONS_OUTDATED");
  const now = deps.now();
  const gate = await gateStart(deps.client, ctx.ipHash, now);
  if (gate.status === "RATE_LIMITED") {
    rejected(ctx.log, "IP_RATE");
    return gate;
  }
  if (await isBreakerOpen(deps.client)) {
    rejected(ctx.log, "BREAKER_OPEN");
    return { status: "CAPACITY" };
  }
  if (gate.status === "CAPACITY") {
    rejected(ctx.log, "TOTAL_CAPACITY");
    return gate;
  }

  const signupId = deps.newSignupId();
  const at = now.toISOString();
  const shownAt = formShownAt(deps.keys.form, input.formToken);
  const versions = deps.legalVersions;
  const referrer = sanitizeReferrer(input.referrer, deps.appOrigin);
  const signup = await deps.signups.create(
    {
      signupId,
      username: `usr-${deps.newUlid().toLowerCase()}`,
      email: input.email,
      emailHash: leadEmailHash(deps.keys.leadEmail, input.email),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.company === undefined ? {} : { company: input.company }),
      ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle }),
      consents: {
        terms: { accepted: true, at, version: versions.terms, privacyVersion: versions.privacy, lang: input.lang },
        contact: { accepted: input.consents.contact, at, version: versions.contact, lang: input.lang },
      },
      language: input.lang,
      utm: sanitizeUtm(input.utm),
      ...(referrer === undefined ? {} : { referrer }),
      startedAt: at,
      ...(shownAt === undefined ? {} : { formShownAt: shownAt.toISOString() }),
      honeypot: input.website.trim() !== "",
      passwordSealed: sealSecret(deps.keys.seal, input.password, sealContext(signupId)),
    },
    now,
  );
  await queueDispatch(deps, signup, "START", signup.dispatchSeq, ctx.log);
  countMetric(ctx.log, SIGNUP_METRICS.started);
  return { status: "CODE_SENT", signupId, resendAfterSec: RESEND_WAIT_SECONDS };
}

export async function signupResend(deps: AccessDeps, signupId: string, ctx: SignupRequestContext): Promise<SignupResendOutput> {
  if (await isBreakerOpen(deps.client)) {
    rejected(ctx.log, "BREAKER_OPEN");
    return { status: "CAPACITY" };
  }
  const now = deps.now();
  const signup = await deps.signups.get(signupId, now);
  if (signup === undefined) return { status: "EXPIRED" };
  if (signup.resends >= RESEND_MAX_PER_SIGNUP) return { status: "RATE_LIMITED", retryAfterSec: Math.max(1, signup.expiresAt - Math.floor(now.getTime() / 1000)) };
  const last = Date.parse(signup.lastResendAt ?? signup.startedAt);
  const wait = Math.ceil((last + RESEND_WAIT_SECONDS * 1000 - now.getTime()) / 1000);
  if (wait > 0) return { status: "RATE_LIMITED", retryAfterSec: wait };
  let updated: PendingSignup;
  try {
    updated = await deps.signups.recordResend(signup, now);
  } catch {
    // Another tab resent at the same moment: that one counts.
    return { status: "RATE_LIMITED", retryAfterSec: RESEND_WAIT_SECONDS };
  }
  await queueDispatch(deps, updated, "RESEND", updated.dispatchSeq, ctx.log);
  return { status: "CODE_SENT", resendAfterSec: RESEND_WAIT_SECONDS };
}

/** Every answer but CONFIRMED waits until 1.5 s after the request started (ADR-0015 §1.1). */
async function padded(deps: Pick<AccessDeps, "now" | "sleep">, startedAtMs: number, answer: SignupConfirmOutput): Promise<SignupConfirmOutput> {
  const remaining = startedAtMs + NON_CONFIRMED_RESPONSE_MS - deps.now().getTime();
  if (remaining > 0) await deps.sleep(remaining);
  return answer;
}

async function wrongCode(deps: AccessDeps, signup: PendingSignup): Promise<SignupConfirmOutput> {
  const updated = await deps.signups.recordWrongCode(signup, deps.now());
  const attemptsLeft = Math.max(0, CONFIRM_MAX_ATTEMPTS - updated.attempts);
  return attemptsLeft === 0 ? { status: "EXPIRED" } : { status: "CODE_INVALID", attemptsLeft };
}

async function decide(deps: AccessDeps, input: { signupId: string; code: string; password: string }, ctx: SignupRequestContext): Promise<SignupConfirmOutput> {
  const now = deps.now();
  const gate = await gateConfirm(deps.client, ctx.ipHash, now);
  if (!gate.ok) {
    rejected(ctx.log, "CONFIRM_IP_RATE");
    return { status: "RATE_LIMITED", retryAfterSec: gate.retryAfterSec };
  }
  const signup = await deps.signups.get(input.signupId, now);
  if (signup === undefined || signup.attempts >= CONFIRM_MAX_ATTEMPTS) return { status: "EXPIRED" };
  const account = signup.accountUsername;
  if (account === undefined || (signup.branch !== "NEW" && signup.branch !== "EXISTING_GUEST")) return wrongCode(deps, signup);
  const outcome = signup.branch === "NEW" ? await deps.cognito.confirmSignUp(account, input.code) : await deps.cognito.confirmForgotPassword(account, input.code, input.password);
  if (outcome === "CODE_MISMATCH" || outcome === "NOT_CONFIRMABLE") return wrongCode(deps, signup);
  if (outcome === "EXPIRED_CODE") return { status: "EXPIRED" };
  if (outcome === "TOO_MANY") return { status: "RATE_LIMITED", retryAfterSec: RESEND_WAIT_SECONDS };
  await deps.signups.markVerified(signup.signupId, deps.now());
  try {
    await finalizeSignup(deps, signup.signupId, ctx.log);
  } catch (error) {
    // The email is verified (`verifiedAt`): the hourly sweep finalizes it; the visitor can sign in now.
    ctx.log.error("signup.finalize.failed", { signupId: signup.signupId, error: error instanceof Error ? error.name : "unknown" });
  }
  return { status: "CONFIRMED" };
}

export async function signupConfirm(deps: AccessDeps, input: { signupId: string; code: string; password: string }, ctx: SignupRequestContext): Promise<SignupConfirmOutput> {
  const startedAtMs = deps.now().getTime();
  const answer = await decide(deps, input, ctx);
  return answer.status === "CONFIRMED" ? answer : padded(deps, startedAtMs, answer);
}
