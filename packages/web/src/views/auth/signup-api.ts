// The four `signup.*` procedures and the guest's bootstrap procedures (`account.world`,
// `account.ensureWorld`, `account.usage`), validated with the shared contract of
// packages/shared/src/signup.ts on the way back, like every edge of the console. They go through the
// untyped client: the `signup` and `guest-world` routers register on their own schedule
// (docs/build-plan.md WP-50, WP-31), and the shared schemas are the contract either way. A refused call
// is classified once here, so every screen says the same thing for the same failure (§8.8).
import {
  AccountUsageOutput,
  AccountWorldOutput,
  EnsureWorldOutput,
  SignupConfirmOutput,
  SignupFormOutput,
  SignupResendOutput,
  SignupStartOutput,
  type SignupStartInput,
} from "@legajo/shared/signup";
import type { Language } from "@legajo/shared";
import { getUntypedClient } from "@trpc/client";
import { toApiError } from "../../lib/api-error";
import type { ConsoleClient } from "../../lib/trpc";
import { wafErrorOf } from "../../lib/waf";

export async function requestFormToken(trpc: ConsoleClient, lang: Language): Promise<string> {
  return SignupFormOutput.parse(await getUntypedClient(trpc).query("signup.form", { lang })).formToken;
}

export async function startSignup(trpc: ConsoleClient, input: SignupStartInput): Promise<SignupStartOutput> {
  return SignupStartOutput.parse(await getUntypedClient(trpc).mutation("signup.start", input));
}

export async function resendCode(trpc: ConsoleClient, signupId: string): Promise<SignupResendOutput> {
  return SignupResendOutput.parse(await getUntypedClient(trpc).mutation("signup.resend", { signupId }));
}

export async function confirmSignup(trpc: ConsoleClient, input: { readonly signupId: string; readonly code: string; readonly password: string }): Promise<SignupConfirmOutput> {
  return SignupConfirmOutput.parse(await getUntypedClient(trpc).mutation("signup.confirm", input));
}

export async function fetchWorld(trpc: ConsoleClient, signal?: AbortSignal): Promise<AccountWorldOutput> {
  return AccountWorldOutput.parse(await getUntypedClient(trpc).query("account.world", undefined, signal ? { signal } : undefined));
}

export async function ensureWorld(trpc: ConsoleClient): Promise<EnsureWorldOutput> {
  return EnsureWorldOutput.parse(await getUntypedClient(trpc).mutation("account.ensureWorld", {}));
}

export async function fetchUsage(trpc: ConsoleClient, signal?: AbortSignal): Promise<AccountUsageOutput> {
  return AccountUsageOutput.parse(await getUntypedClient(trpc).query("account.usage", undefined, signal ? { signal } : undefined));
}

/** A failed access call as the screen tells it (docs/landing-spec.md §8.8). */
export type AccessFailure =
  | { readonly kind: "challenge" }
  | { readonly kind: "rateLimitedEdge" }
  | { readonly kind: "staleTexts" }
  /** Form errors only, by field (`zodError.fieldErrors` of the BFF): never a word about the email. */
  | { readonly kind: "invalid"; readonly fields: readonly string[] }
  | { readonly kind: "quota"; readonly data: unknown }
  | { readonly kind: "offline" }
  | { readonly kind: "unexpected"; readonly reference: string };

function fieldsOf(error: unknown): string[] {
  const data = typeof error === "object" && error !== null && "data" in error ? (error as { data: unknown }).data : undefined;
  const zodError = typeof data === "object" && data !== null && "zodError" in data ? (data as { zodError: unknown }).zodError : undefined;
  const fieldErrors = typeof zodError === "object" && zodError !== null && "fieldErrors" in zodError ? (zodError as { fieldErrors: unknown }).fieldErrors : undefined;
  return typeof fieldErrors === "object" && fieldErrors !== null ? Object.keys(fieldErrors) : [];
}

function quotaOf(error: unknown): unknown {
  const data = typeof error === "object" && error !== null && "data" in error ? (error as { data: unknown }).data : undefined;
  return typeof data === "object" && data !== null && "quota" in data ? (data as { quota: unknown }).quota : undefined;
}

export function accessFailureOf(error: unknown): AccessFailure {
  const waf = wafErrorOf(error);
  if (waf === "challenge") return { kind: "challenge" };
  if (waf === "blocked") return { kind: "rateLimitedEdge" };
  const api = toApiError(error);
  if (api.reason === "CONSENT_VERSIONS_OUTDATED") return { kind: "staleTexts" };
  if (api.reason === "QUOTA_EXCEEDED") return { kind: "quota", data: quotaOf(error) };
  if (api.code === "BAD_REQUEST") return { kind: "invalid", fields: fieldsOf(error) };
  if (api.kind === "network") return { kind: "offline" };
  return { kind: "unexpected", reference: api.correlationId ?? "—" };
}
