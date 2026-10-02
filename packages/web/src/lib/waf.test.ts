import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WafBlockedError,
  WafChallengeError,
  assertNotWaf,
  challengeOutcome,
  challengeRetryUrl,
  isWafChallenge,
  saveChallengeDraft,
  takeChallengeDraft,
  wafErrorOf,
} from "./waf";

function answer(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "", { status, headers });
}

class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  snapshot(): string {
    return JSON.stringify([...this.items.entries()]);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("[FL-113] silent WAF challenge of the sign-up, without SDK (ADR-0015 §3.3)", () => {
  it("[FL-113] tells a challenge (202 + x-amzn-waf-action) from an answer and from WAF's 403", () => {
    expect(isWafChallenge(answer(202, { "x-amzn-waf-action": "challenge" }))).toBe(true);
    expect(isWafChallenge(answer(202, { "X-Amzn-Waf-Action": "Challenge" }))).toBe(true);
    expect(isWafChallenge(answer(202))).toBe(false);
    expect(isWafChallenge(answer(200, { "x-amzn-waf-action": "challenge" }))).toBe(false);

    expect(() => assertNotWaf(answer(202, { "x-amzn-waf-action": "challenge" }))).toThrow(WafChallengeError);
    expect(() => assertNotWaf(answer(403, { "content-type": "text/html" }))).toThrow(WafBlockedError);
    // The BFF's own 403 (origin header, firm fence) is JSON and goes on to tRPC.
    const bff = answer(403, { "content-type": "application/json" });
    expect(assertNotWaf(bff)).toBe(bff);
  });

  it("[FL-113] finds the WAF error behind tRPC's wrapping", () => {
    const wrapped = new Error("fetch failed", { cause: new Error("link", { cause: new WafChallengeError("x") }) });
    expect(wafErrorOf(wrapped)).toBe("challenge");
    expect(wafErrorOf(new Error("x", { cause: new WafBlockedError("y") }))).toBe("blocked");
    expect(wafErrorOf(new Error("other"))).toBeUndefined();
  });

  it("[FL-113] keeps only the fields that are not secret across the reload, once", () => {
    const store = new MemoryStorage();
    vi.stubGlobal("window", { sessionStorage: store });
    saveChallengeDraft({ email: "ana@sim.legajo.demo.craftech.io", name: "Ana", terms: true, contact: false, password: "Secreta-1234!", code: "123456" });
    expect(store.snapshot()).not.toContain("Secreta");
    expect(store.snapshot()).not.toContain("123456");
    expect(takeChallengeDraft()).toEqual({ email: "ana@sim.legajo.demo.craftech.io", name: "Ana", terms: true, contact: false });
    expect(takeChallengeDraft()).toBeUndefined();
  });

  it("[FL-113] survives a browser where storage throws", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("denied");
      },
    });
    expect(() => saveChallengeDraft({ email: "x" })).not.toThrow();
    expect(takeChallengeDraft()).toBeUndefined();
  });

  it("[FL-113] reloads /signup once with the same query, and fails the second time", () => {
    const search = new URLSearchParams("lang=en&utm_source=feria");
    expect(challengeRetryUrl("/signup", search)).toBe("/signup?lang=en&utm_source=feria&retry=1");
    expect(challengeOutcome(search)).toBe("reload");
    expect(challengeOutcome(new URLSearchParams("retry=1"))).toBe("failed");
  });
});
