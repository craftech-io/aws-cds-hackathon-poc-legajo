// Usage limits of a guest world as the console tells them (docs/landing-spec.md §8.5, FL-111): the
// `QUOTA_EXCEEDED {kind, resetsAtReal}` of any procedure, read from the error's `data.quota`
// (packages/shared/src/signup.ts), the sentence with the local time it resets, and the usage lines of
// `account.usage`. Windows and caps come from guest-limits.ts and the BFF, never from here.
import type { QuotaExceededKind, QuotaKind } from "@legajo/shared/guest-limits";
import { QuotaExceededData, type QuotaUsage } from "@legajo/shared/signup";
import type { AuthCopy } from "./copy";

export function quotaOfRefusal(data: unknown): QuotaExceededData | undefined {
  const quota = typeof data === "object" && data !== null && "quota" in data ? (data as { quota: unknown }).quota : data;
  const parsed = QuotaExceededData.safeParse(quota);
  return parsed.success ? parsed.data : undefined;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `HH:MM` of an instant in the browser's own time zone. */
export function localTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "--:--" : `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A counter that resets at 00:00 UTC is a daily one; anything else resets within the day. */
export function isDailyReset(iso: string): boolean {
  const at = new Date(iso);
  return at.getUTCHours() === 0 && at.getUTCMinutes() === 0 && at.getUTCSeconds() === 0;
}

export function quotaLabel(copy: AuthCopy, kind: QuotaKind): string {
  return copy.quota.kinds[kind];
}

/** "Llegaste al límite de esta demo por hoy (movimientos del reloj); se renueva a las 21:00." */
export function quotaMessage(copy: AuthCopy, quota: { readonly kind: QuotaExceededKind; readonly resetsAtReal: string }): string {
  const time = localTime(quota.resetsAtReal);
  if (quota.kind === "GLOBAL") return copy.quota.global(time);
  const what = quotaLabel(copy, quota.kind);
  return isDailyReset(quota.resetsAtReal) ? copy.quota.day(what, time) : copy.quota.hour(what, time);
}

export interface UsageLine {
  readonly kind: QuotaKind;
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly exhausted: boolean;
}

/** One line per kind: the window closest to its cap. */
export function usageLines(copy: AuthCopy, quotas: readonly QuotaUsage[]): UsageLine[] {
  const tightest = new Map<QuotaKind, QuotaUsage>();
  for (const quota of quotas) {
    const current = tightest.get(quota.kind);
    if (!current || quota.used / quota.limit > current.used / current.limit) tightest.set(quota.kind, quota);
  }
  return [...tightest.values()].map((quota) => ({
    kind: quota.kind,
    label: quotaLabel(copy, quota.kind),
    used: quota.used,
    limit: quota.limit,
    exhausted: quota.used >= quota.limit,
  }));
}
