import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOKENS_KEY, loadTokens, refreshTokens, saveTokens, type TokenSet } from "../../lib/auth/tokens";
import { cameUnconfirmed, destinationAfterSignIn, endSession, isSignedOutLanding, needsWorld, signedOutHref } from "./session";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  Object.assign(globalThis, { sessionStorage: storage });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

const TOKENS: TokenSet = { idToken: "id", accessToken: "access", refreshToken: "refresh-guest", expiresAt: Date.now() + 900_000 };

describe("[FL-108] signing out", () => {
  it("[FL-108] revokes the refresh token and clears the tokens of the tab", async () => {
    saveTokens(TOKENS);
    const revoked: string[] = [];
    await endSession({ revoke: async (token) => void revoked.push(token) }, TOKENS);
    expect(revoked).toEqual(["refresh-guest"]);
    expect(storage.items.has(TOKENS_KEY)).toBe(false);
  });

  it("[FL-108] drops a refresh that was in flight, so no token comes back after it", async () => {
    const stale = { ...TOKENS, expiresAt: Date.now() - 1 };
    saveTokens(stale);
    let answer: () => void = () => undefined;
    const refresh = refreshTokens(
      { refresh: () => new Promise((resolve) => (answer = () => resolve({ IdToken: "late-id", AccessToken: "late-access", ExpiresIn: 900 }))) },
      stale,
    );
    await endSession({ revoke: async () => undefined }, stale);
    answer();
    await expect(refresh).rejects.toThrow();
    expect(loadTokens()).toBeUndefined();
  });

  it("[FL-108] still signs out locally when Cognito cannot be reached", async () => {
    saveTokens(TOKENS);
    await endSession({ revoke: () => Promise.reject(new Error("offline")) }, TOKENS);
    expect(loadTokens()).toBeUndefined();
    await expect(endSession(undefined, undefined)).resolves.toBeUndefined();
  });

  it("[FL-108] lands on the landing with the notice, in the person's language", () => {
    expect(signedOutHref("es")).toBe("/?signedOut=1");
    expect(signedOutHref("en")).toBe("/?signedOut=1&lang=en");
    expect(isSignedOutLanding(new URLSearchParams("signedOut=1"))).toBe(true);
    expect(isSignedOutLanding(new URLSearchParams(""))).toBe(false);
  });
});

describe("[FL-105] where a sign-in lands", () => {
  it("[FL-105] sends a guest without a firm to /welcome and everybody else where they were going", () => {
    expect(needsWorld({ isGuest: true })).toBe(true);
    expect(destinationAfterSignIn({ isGuest: true }, "/app/audit")).toBe("/welcome");
    expect(destinationAfterSignIn({ isGuest: true, firmId: "firm-guest-41" }, "/app/audit")).toBe("/app/audit");
    expect(destinationAfterSignIn({ isGuest: false }, "/app/operations")).toBe("/app/operations");
  });

  it("[FL-106] tells the screens they were reached from an unverified sign-in", () => {
    expect(cameUnconfirmed(new URLSearchParams("notice=unconfirmed"))).toBe(true);
    expect(cameUnconfirmed(new URLSearchParams("notice=other"))).toBe(false);
  });
});
