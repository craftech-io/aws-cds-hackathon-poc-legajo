// Rules of `/welcome` without React (docs/landing-spec.md §8.5, ADR-0015 §4; FL-105, FL-109 to
// FL-111, FL-132). The page reads `account.world` first; a world that is not alive gets one
// `account.ensureWorld` per visit (an `EXPIRED` one with its notice), then `account.world` every 2 s
// while it is `CREATING`. `READY` refreshes the tokens and opens the console. `CAPACITY` keeps the
// account and the lead and tries again every minute while the tab is visible. A transport error, or a
// minute stuck in `CREATING`, reads as `FAILED` (a state of the screen only). Quotas are not a state of
// the world: an `ensureWorld` over its hourly cap answers `QUOTA_EXCEEDED`, shown with its reset time.
import type { EnsureWorldOutput, GuestWorldState, QuotaExceededData } from "@legajo/shared/signup";

export const WELCOME_TIMING = {
  /** `account.world` while the world is being created. */
  pollMs: 2_000,
  /** Longer than this in `CREATING` and the screen says it failed. */
  creatingTimeoutMs: 60_000,
  /** With the demo full, another `ensureWorld` this often while the tab is visible. */
  capacityRetryMs: 60_000,
} as const;

export type WelcomeScreen =
  | { readonly kind: "loading" }
  | { readonly kind: "preparing"; readonly expired: boolean }
  | { readonly kind: "capacity" }
  | { readonly kind: "failed" }
  | { readonly kind: "quota"; readonly quota: QuotaExceededData }
  | { readonly kind: "ready" };

export interface WelcomeState {
  readonly screen: WelcomeScreen;
  /** This visit already asked for a world (one `ensureWorld` per visit, plus explicit retries). */
  readonly ensured: boolean;
  /** Epoch ms of the first `CREATING` seen. */
  readonly creatingSince?: number;
}

/** What the page does next: ask for a world, read it again in a moment, refresh the tokens, retry later, or wait. */
export type WelcomeEffect = "ensure" | "poll" | "refresh" | "retryLater" | "none";

export interface WelcomeStep {
  readonly state: WelcomeState;
  readonly effect: WelcomeEffect;
}

export const INITIAL_WELCOME: WelcomeState = { screen: { kind: "loading" }, ensured: false };

function creating(state: WelcomeState, now: number, expired: boolean): WelcomeStep {
  const since = state.creatingSince ?? now;
  if (now - since >= WELCOME_TIMING.creatingTimeoutMs) return { state: { ...state, screen: { kind: "failed" }, creatingSince: since }, effect: "none" };
  return { state: { ...state, screen: { kind: "preparing", expired }, creatingSince: since }, effect: "poll" };
}

function expiredShown(state: WelcomeState): boolean {
  return state.screen.kind === "preparing" && state.screen.expired;
}

/** An answer of `account.world`. */
export function onWorld(state: WelcomeState, world: GuestWorldState, now: number): WelcomeStep {
  switch (world) {
    case "READY":
      return { state: { ...state, screen: { kind: "ready" } }, effect: "refresh" };
    case "CREATING":
      return creating(state, now, expiredShown(state));
    case "CAPACITY":
      if (state.ensured) return { state: { ...state, screen: { kind: "capacity" } }, effect: "retryLater" };
      break;
    case "FAILED":
      if (state.ensured) return { state: { ...state, screen: { kind: "failed" } }, effect: "none" };
      break;
    case "NONE":
    case "EXPIRED":
      if (state.ensured) return { state: { ...state, screen: { kind: "failed" } }, effect: "none" };
      break;
  }
  // No live world and none asked for in this visit yet: ask once.
  return { state: { ...state, screen: { kind: "preparing", expired: world === "EXPIRED" }, ensured: true }, effect: "ensure" };
}

/** The answer of `account.ensureWorld`. */
export function onEnsure(state: WelcomeState, answer: EnsureWorldOutput["state"], now: number): WelcomeStep {
  switch (answer) {
    case "READY":
      return { state: { ...state, ensured: true, screen: { kind: "ready" } }, effect: "refresh" };
    case "CREATING":
      return creating({ ...state, ensured: true }, now, expiredShown(state));
    case "CAPACITY":
      return { state: { ...state, ensured: true, screen: { kind: "capacity" } }, effect: "retryLater" };
  }
}

/** A failed call: the quota of world preparations, or anything else (transport, 5xx). */
export function onFailure(state: WelcomeState, quota: QuotaExceededData | undefined): WelcomeStep {
  if (quota) return { state: { ...state, screen: { kind: "quota", quota } }, effect: "none" };
  return { state: { ...state, screen: { kind: "failed" } }, effect: "none" };
}

/** "Probar de nuevo", or the minute of the full demo going by: a new `ensureWorld`. */
export function onRetry(): WelcomeStep {
  return { state: { ensured: true, screen: { kind: "preparing", expired: false } }, effect: "ensure" };
}

/**
 * A minute going by: only the full demo tries again by itself, and only with the tab in sight. The
 * screen stays as it is while the request is out, so a demo that is still full does not flicker.
 */
export function onRetryTimer(state: WelcomeState, visible: boolean): WelcomeStep {
  if (state.screen.kind !== "capacity") return { state, effect: "none" };
  return visible ? { state, effect: "ensure" } : { state, effect: "retryLater" };
}
