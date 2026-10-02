// What travels between the access screens of one tab (docs/landing-spec.md §8.3, §8.4):
//   - the sign-up in progress (its id, the email, when another code may be asked for and how many
//     were resent) in sessionStorage, so `/signup/verify` survives a reload and `/login` can send an
//     unverified account back to it; it dies with the tab;
//   - the password of the form only in memory, between `/signup` and `/signup/verify`, never stored;
//   - the email `/login` shows after a verification or a reset, in memory too.
// The form `/signup` gets back ("Cambiar email", an unverified sign-in) crosses a full page load, so
// it travels as the non-secret draft of lib/waf.ts. Nothing here goes to a URL or to a log.
import { z } from "zod";

const PENDING_KEY = "legajo.signup.pending";

const PendingSignup = z.object({
  signupId: z.string().min(1).max(64),
  email: z.string().min(3).max(254),
  /** Epoch ms from which another code may be asked for. */
  resendAvailableAt: z.number().int().nonnegative(),
  resends: z.number().int().nonnegative(),
  /** The other fields of the form, not secret, for "Cambiar email" and "Empezar de nuevo". */
  fields: z
    .object({ name: z.string().max(200), company: z.string().max(200), jobTitle: z.string().max(200), terms: z.boolean(), contact: z.boolean() })
    .optional(),
});
export type PendingSignup = z.infer<typeof PendingSignup>;

function session(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function savePendingSignup(pending: PendingSignup): void {
  try {
    session()?.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Not kept: a reload of /signup/verify asks to start again.
  }
}

export function readPendingSignup(): PendingSignup | undefined {
  try {
    const raw = session()?.getItem(PENDING_KEY);
    if (!raw) return undefined;
    const parsed = PendingSignup.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingSignup(): void {
  try {
    session()?.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
}

interface Memory {
  password?: string;
  loginEmail?: string;
}

const memory: Memory = {};

/** The password typed on /signup, for `signup.confirm` on /signup/verify. Memory only. */
export function holdPassword(password: string): void {
  memory.password = password;
}

export function heldPassword(): string | undefined {
  return memory.password;
}

export function forgetPassword(): void {
  delete memory.password;
}

/** The email `/login` pre-fills after a verification or a password reset. */
export function holdLoginEmail(email: string): void {
  memory.loginEmail = email;
}

export function takeLoginEmail(): string | undefined {
  const email = memory.loginEmail;
  delete memory.loginEmail;
  return email;
}

/** Everything of a finished or abandoned sign-up. */
export function forgetSignup(): void {
  clearPendingSignup();
  forgetPassword();
}
