// Password policy of the user pool, in one place: infra/auth.ts configures Cognito with it, the
// sign-up form shows its checklist from it and `signup.start` refuses a password outside it before
// anything is stored (ADR-0015 §1). Cognito would refuse such a password later, inside
// `SignupDispatch`, where the visitor could no longer be told; checking here keeps the answer honest.
import { z } from "zod";

export const PASSWORD_POLICY = {
  minLength: 12,
  /** Cognito never accepts more than this. */
  maxLength: 256,
  requireLowercase: true,
  requireUppercase: true,
  requireNumbers: true,
  requireSymbols: true,
} as const;

/** Cognito's special characters (a space counts too, but never at either end). */
export const PASSWORD_SYMBOLS = "^$*.[]{}()?\"!@#%&/\\,><':;|_~`=+- ";

export const PasswordRule = z.enum(["LENGTH", "LOWERCASE", "UPPERCASE", "NUMBER", "SYMBOL", "EDGE_SPACE"]);
export type PasswordRule = z.infer<typeof PasswordRule>;

/** The rules `password` breaks, in checklist order; empty when it meets the policy. */
export function passwordProblems(password: string): PasswordRule[] {
  const problems: PasswordRule[] = [];
  const length = [...password].length;
  if (length < PASSWORD_POLICY.minLength || length > PASSWORD_POLICY.maxLength) problems.push("LENGTH");
  if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) problems.push("LOWERCASE");
  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) problems.push("UPPERCASE");
  if (PASSWORD_POLICY.requireNumbers && !/[0-9]/.test(password)) problems.push("NUMBER");
  if (PASSWORD_POLICY.requireSymbols && ![...password].some((char) => char !== " " && PASSWORD_SYMBOLS.includes(char))) problems.push("SYMBOL");
  if (password !== password.trim()) problems.push("EDGE_SPACE");
  return problems;
}

/** A password that meets the pool's policy; the message never echoes the value. */
export const Password = z.string().refine((value) => passwordProblems(value).length === 0, "the password does not meet the policy");
