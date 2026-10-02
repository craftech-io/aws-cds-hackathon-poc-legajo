// What went wrong in a sign-in step, as the screen needs it. Cognito's error types are collapsed
// into a few codes whose texts never say whether an account exists: a wrong password, an unknown
// email or username and an account that must reset its password all read the same.
import { CognitoError } from "./cognito";
import { SrpError } from "./srp";

export type AuthFlowErrorCode =
  /** Sign-in name or password not accepted (never says which, nor whether the account exists). */
  | "INVALID_CREDENTIALS"
  /**
   * The password is right but the email was never verified. Cognito answers this only after the
   * password proof, so it reveals nothing to somebody who does not know the password.
   */
  | "UNCONFIRMED"
  /** A TOTP or reset code that is wrong or expired. */
  | "INVALID_CODE"
  /** The new password does not meet the pool's policy. */
  | "WEAK_PASSWORD"
  /** The challenge took too long; start again from the email and password. */
  | "SESSION_EXPIRED"
  | "TOO_MANY_ATTEMPTS"
  /** Cognito or the network did not answer. */
  | "UNAVAILABLE"
  /** A challenge this console does not handle (SMS or email MFA are not configured). */
  | "UNSUPPORTED"
  /** A step-up that signed in as somebody else than the current session. */
  | "DIFFERENT_USER";

/** Where the error happened; `change` is a signed-in user changing its own password. */
export type FlowStep = "credentials" | "challenge" | "setup" | "reset" | "change";

const THROTTLED = new Set(["LimitExceededException", "TooManyRequestsException", "TooManyFailedAttemptsException"]);
const BAD_CODE = new Set(["CodeMismatchException", "ExpiredCodeException", "EnableSoftwareTokenMFAException"]);
// Refusals of the email + password step. PasswordResetRequired would reveal that the account exists,
// so it is reported as a plain rejection too. UserNotConfirmed comes only with the right password
// (docs/landing-spec.md §8.4), so the sign-in can send the person to verify the email.
const REJECTED = new Set(["NotAuthorizedException", "UserNotFoundException", "PasswordResetRequiredException", "InvalidParameterException"]);

export function errorCodeOf(error: unknown, step: FlowStep): AuthFlowErrorCode {
  if (error instanceof SrpError) return "INVALID_CREDENTIALS";
  if (!(error instanceof CognitoError)) return "UNAVAILABLE";
  const { type } = error;
  if (THROTTLED.has(type)) return "TOO_MANY_ATTEMPTS";
  if (type === "InvalidPasswordException") return step === "credentials" ? "INVALID_CREDENTIALS" : "WEAK_PASSWORD";
  switch (step) {
    case "credentials":
      if (type === "UserNotConfirmedException") return "UNCONFIRMED";
      return REJECTED.has(type) ? "INVALID_CREDENTIALS" : "UNAVAILABLE";
    case "challenge":
    case "setup":
      if (BAD_CODE.has(type)) return "INVALID_CODE";
      // A challenge session that expired or was already used answers NotAuthorized.
      return type === "NotAuthorizedException" ? "SESSION_EXPIRED" : "UNAVAILABLE";
    case "reset":
      if (BAD_CODE.has(type) || REJECTED.has(type) || type === "UserNotConfirmedException") return "INVALID_CODE";
      return "UNAVAILABLE";
    case "change":
      // A wrong current password answers NotAuthorized, like a sign-in with the wrong one.
      return type === "NotAuthorizedException" ? "INVALID_CREDENTIALS" : "UNAVAILABLE";
  }
}
