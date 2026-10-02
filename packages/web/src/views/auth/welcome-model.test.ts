import { describe, expect, it } from "vitest";
import { INITIAL_WELCOME, WELCOME_TIMING, type WelcomeState, onEnsure, onFailure, onRetry, onRetryTimer, onWorld } from "./welcome-model";

const T0 = 1_000_000;

describe("[FL-105] preparing a public guest's world", () => {
  it("[FL-105] asks once for a world, reads it every 2 s while it is created, and refreshes the tokens when ready", () => {
    const first = onWorld(INITIAL_WELCOME, "NONE", T0);
    expect(first).toEqual({ state: { ensured: true, screen: { kind: "preparing", expired: false } }, effect: "ensure" });
    const creating = onEnsure(first.state, "CREATING", T0 + 50);
    expect(creating.effect).toBe("poll");
    expect(creating.state.screen).toEqual({ kind: "preparing", expired: false });
    const still = onWorld(creating.state, "CREATING", T0 + WELCOME_TIMING.pollMs);
    expect(still.effect).toBe("poll");
    expect(onWorld(still.state, "READY", T0 + 2 * WELCOME_TIMING.pollMs)).toEqual({ state: { ...still.state, screen: { kind: "ready" } }, effect: "refresh" });
  });

  it("[FL-105] never asks again in the same visit: a second empty answer reads as failed", () => {
    const asked = onWorld(INITIAL_WELCOME, "NONE", T0).state;
    expect(onWorld(asked, "NONE", T0 + 10)).toEqual({ state: { ...asked, screen: { kind: "failed" } }, effect: "none" });
    expect(onWorld(asked, "FAILED", T0 + 10).state.screen).toEqual({ kind: "failed" });
  });

  it("[FL-105] opens the console straight away when the world is already ready", () => {
    expect(onWorld(INITIAL_WELCOME, "READY", T0).effect).toBe("refresh");
    expect(onEnsure(onWorld(INITIAL_WELCOME, "NONE", T0).state, "READY", T0).effect).toBe("refresh");
  });

  it("[FL-105] shows a world stuck in creation for a minute as failed, and a retry asks again", () => {
    const creating = onEnsure(onWorld(INITIAL_WELCOME, "NONE", T0).state, "CREATING", T0);
    const late = onWorld(creating.state, "CREATING", T0 + WELCOME_TIMING.creatingTimeoutMs);
    expect(late).toEqual({ state: { ...late.state, screen: { kind: "failed" } }, effect: "none" });
    expect(onRetry()).toEqual({ state: { ensured: true, screen: { kind: "preparing", expired: false } }, effect: "ensure" });
  });

  it("[FL-105] reads a transport error as failed", () => {
    expect(onFailure(INITIAL_WELCOME, undefined).state.screen).toEqual({ kind: "failed" });
  });
});

describe("[FL-109] a world that expired", () => {
  it("[FL-109] says the previous world was deleted and prepares a new one from day 0", () => {
    const step = onWorld(INITIAL_WELCOME, "EXPIRED", T0);
    expect(step).toEqual({ state: { ensured: true, screen: { kind: "preparing", expired: true } }, effect: "ensure" });
    const creating = onEnsure(step.state, "CREATING", T0);
    expect(creating.state.screen).toEqual({ kind: "preparing", expired: true });
    expect(onWorld(creating.state, "CREATING", T0 + WELCOME_TIMING.pollMs).state.screen).toEqual({ kind: "preparing", expired: true });
  });
});

describe("[FL-110] [FL-132] the demo is full", () => {
  it("[FL-132] keeps the account, creates nothing, and tries again every minute only while the tab is in sight", () => {
    const asked = onWorld(INITIAL_WELCOME, "NONE", T0).state;
    const full = onEnsure(asked, "CAPACITY", T0);
    expect(full).toEqual({ state: { ...asked, screen: { kind: "capacity" } }, effect: "retryLater" });
    expect(onRetryTimer(full.state, false)).toEqual({ state: full.state, effect: "retryLater" });
    const again = onRetryTimer(full.state, true);
    expect(again).toEqual({ state: full.state, effect: "ensure" });
    expect(onEnsure(again.state, "CREATING", T0 + WELCOME_TIMING.capacityRetryMs).effect).toBe("poll");
  });

  it("[FL-110] a world that answers full on arrival asks for a world first", () => {
    expect(onWorld(INITIAL_WELCOME, "CAPACITY", T0).effect).toBe("ensure");
    const asked: WelcomeState = { ensured: true, screen: { kind: "preparing", expired: false } };
    expect(onWorld(asked, "CAPACITY", T0).effect).toBe("retryLater");
  });

  it("[FL-110] a minute going by does nothing once the screen is no longer the full demo", () => {
    const preparing: WelcomeState = { ensured: true, screen: { kind: "preparing", expired: false } };
    expect(onRetryTimer(preparing, true)).toEqual({ state: preparing, effect: "none" });
  });
});

describe("[FL-111] the hourly cap of world preparations", () => {
  it("[FL-111] shows the quota with its reset time instead of failing", () => {
    const quota = { kind: "WORLD_PREPARATIONS", resetsAtReal: "2026-10-14T14:00:00.000Z" } as const;
    expect(onFailure(INITIAL_WELCOME, quota)).toEqual({ state: { ...INITIAL_WELCOME, screen: { kind: "quota", quota } }, effect: "none" });
  });
});
