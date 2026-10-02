// Cognito pre sign-up trigger `AuthPreSignUp` (ADR-0015 §1): HMAC only, no table, answers in
// milliseconds. Before the user exists and before any email:
//
//   PreSignUp_SignUp            only with a valid ticket in `ValidationData` (signup/ticket.ts), the one
//                               `SignupDispatch` makes for this user name and email, at most 120 s old;
//                               so a `SignUp` straight on the public client creates nothing and mails nothing
//   PreSignUp_AdminCreateUser   passes (only the operator holds administrator credentials)
//   PreSignUp_ExternalProvider  refused (and anything else)
//
// It never confirms a user nor verifies an email by itself: the code does.
import { z } from "zod";
import { countMetric } from "../channels/adapter";
import { type SecretKey, leadEmailHash } from "../lib/crypto";
import { createLogger, type Logger } from "../lib/log";
import { subkey } from "../lib/secrets";
import { SIGNUP_METRICS } from "../signup/dispatch";
import { verifyTicket } from "../signup/ticket";

const StringMap = z.record(z.string(), z.string());

export const PreSignUpEvent = z.looseObject({
  triggerSource: z.string().min(1),
  userName: z.string().min(1),
  request: z.looseObject({
    userAttributes: StringMap,
    validationData: StringMap.nullish(),
  }),
});

export interface PreSignUpDeps {
  readonly ticketKey: () => SecretKey;
  readonly leadEmailKey: () => SecretKey;
  readonly now: () => Date;
  readonly log: Logger;
}

export type PreSignUpVerdict = "ACCEPT" | "NO_TICKET" | "BAD_TICKET" | "EXPIRED_TICKET" | "EXTERNAL_PROVIDER" | "UNKNOWN_SOURCE";

export function decidePreSignUp(event: z.infer<typeof PreSignUpEvent>, deps: Omit<PreSignUpDeps, "log">): PreSignUpVerdict {
  if (event.triggerSource === "PreSignUp_AdminCreateUser") return "ACCEPT";
  if (event.triggerSource === "PreSignUp_ExternalProvider") return "EXTERNAL_PROVIDER";
  if (event.triggerSource !== "PreSignUp_SignUp") return "UNKNOWN_SOURCE";
  const email = event.request.userAttributes.email;
  if (email === undefined) return "NO_TICKET";
  let emailHash: string;
  try {
    emailHash = leadEmailHash(deps.leadEmailKey(), email);
  } catch {
    return "BAD_TICKET";
  }
  const verdict = verifyTicket(deps.ticketKey(), { username: event.userName, emailHash }, event.request.validationData ?? undefined, deps.now());
  return verdict === "VALID" ? "ACCEPT" : verdict === "MISSING" ? "NO_TICKET" : verdict === "EXPIRED" ? "EXPIRED_TICKET" : "BAD_TICKET";
}

export type PreSignUpHandler = (event: unknown) => Promise<unknown>;

/** Accepts by returning the event (never auto-confirming); refuses by throwing, so Cognito creates nothing. */
export function createPreSignUpHandler(resolveDeps: () => PreSignUpDeps): PreSignUpHandler {
  return async (raw) => {
    const deps = resolveDeps();
    const parsed = PreSignUpEvent.safeParse(raw);
    if (!parsed.success) {
      deps.log.error("auth.presignup.invalid_event", { issues: parsed.error.issues.length });
      throw new Error("the sign-up was refused");
    }
    const verdict = decidePreSignUp(parsed.data, deps);
    if (verdict !== "ACCEPT") {
      countMetric(deps.log, SIGNUP_METRICS.rejected, { reason: verdict === "EXTERNAL_PROVIDER" ? "EXTERNAL_PROVIDER" : "TICKET", verdict });
      throw new Error("the sign-up was refused");
    }
    return { ...parsed.data, response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false } };
  };
}

export const handler: PreSignUpHandler = createPreSignUpHandler(() => ({
  ticketKey: () => subkey("signup-ticket"),
  leadEmailKey: () => subkey("lead-email"),
  now: () => new Date(),
  log: createLogger({ bindings: { service: "auth-pre-signup" } }),
}));
