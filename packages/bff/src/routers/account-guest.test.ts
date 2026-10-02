// A guest's account (ADR-0015 §1 and §4): `account.session` before its world exists and after it is gone
// (the world's state, never a 403), the sign-in recorded on a public guest's lead, `account.usage`, and
// what a guest may never do with its account (FL-107: a password changes only through recovery).
import { beforeEach, describe, expect, it } from "vitest";
import { GUEST_QUOTAS } from "@legajo/shared/guest-limits";
import { seedBrokers } from "../auth/testing";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { leadEmailHash } from "../lib/crypto";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { type Bff, bffFor, call, trpcEvent } from "../signup/testing-http";
import { consumeQuota } from "../worlds/guest-quotas";
import { leaseAccountWorld, markAccountWorld } from "../worlds/guest-slots";
import { createLogger } from "../lib/log";
import { QuotaExceededError } from "@legajo/shared/errors";
import { createContextFactory, guestBootstrapProcedure, router } from "./trpc";
import { createHandler } from "./handler";
import { testEdgeGuard } from "../signup/testing";

const SUB = "5a1d0c3e-0000-4000-8000-0000000000aa";
const EMAIL = "ana.gomez@despachos-del-sur.com.ar";
const NOW = new Date("2026-10-14T13:30:00.000Z");

let stores: MemoryStores;
let access: TestAccess;
let bff: Bff;

beforeEach(() => {
  stores = memoryStores();
  access = testAccessDeps(stores, { now: () => NOW });
  bff = bffFor(stores, access);
});

/** A public guest's token: no firm until its world's broker row exists (auth-triggers/pre-token.ts). */
function token(claims: Record<string, unknown> = {}): string {
  return bff.issuer.idToken({ sub: SUB, "cognito:username": "usr-01j9zq00000000000000000001", email: EMAIL, "custom:firmId": undefined, "custom:role": "GUEST", "custom:isGuest": "true", "cognito:groups": ["GUEST"], auth_time: Math.floor(NOW.getTime() / 1000), ...claims });
}

const get = (path: string, bearer: string) => call(bff, trpcEvent("GET", path, { input: {}, headers: { "x-legajo-auth": `Bearer ${bearer}` } }));

async function seedLead(): Promise<void> {
  const consent = { accepted: true, at: "2026-10-14T13:00:00.000Z", version: access.legalVersions.terms, lang: "es" as const };
  await access.leads.saveVerifiedLead(
    { newLeadId: "01J9ZQ00000000000000000077", email: EMAIL, emailHash: leadEmailHash(access.keys.leadEmail, EMAIL), consents: { terms: { ...consent, privacyVersion: access.legalVersions.privacy }, contact: consent }, language: "es", utm: {}, signupAt: consent.at, confirmedAt: consent.at, cognitoUsername: "usr-01j9zq00000000000000000001" },
    NOW,
  );
}

describe("[FL-105] account.session of a guest before its world", () => {
  it("answers the world's state (NONE) with no firm, and records the sign-in on the lead", async () => {
    await seedLead();
    const session = await get("/api/account.session", token());
    expect(session).toMatchObject({ status: 200, data: { firm: null, firmId: null, role: "GUEST", isGuest: true, world: "NONE", guestKind: "PUBLIC", canChangePassword: false, canSetUpMfa: false } });
    expect((await access.leads.get(leadEmailHash(access.keys.leadEmail, EMAIL)))?.lastLoginAt).toBe(NOW.toISOString());
    // An older sign-in never moves it back.
    await get("/api/account.session", token({ auth_time: Math.floor(NOW.getTime() / 1000) - 3_600 }));
    expect((await access.leads.get(leadEmailHash(access.keys.leadEmail, EMAIL)))?.lastLoginAt).toBe(NOW.toISOString());
  });

  it("[FL-110] [FL-132] says CREATING, READY or CAPACITY from the account's lease", async () => {
    const lease = await leaseAccountWorld(stores.client, SUB, "lease-1", NOW);
    expect(lease.won).toBe(true);
    expect((await get("/api/account.session", token())).data).toMatchObject({ world: "CREATING" });
    await markAccountWorld(stores.client, SUB, "lease-1", { state: "FAILED", reason: "CAPACITY" }, NOW);
    expect((await get("/api/account.session", token())).data).toMatchObject({ world: "CAPACITY" });
  });

  it("[FL-109] a token whose world is gone gets EXPIRED from session, never a 403", async () => {
    await seedBrokers(stores, [{ firmId: "firm-guest-41", brokerId: "brk-guest-41", role: "GUEST", sub: SUB }]);
    await leaseAccountWorld(stores.client, SUB, "lease-1", NOW);
    await markAccountWorld(stores.client, SUB, "lease-1", { state: "DESTROYED", nn: 41, firmId: "firm-guest-41" }, NOW);
    await stores.client.delete("Firms", { PK: "FIRM#firm-guest-41", SK: "BROKER#brk-guest-41" });
    const stale = token({ "custom:firmId": "firm-guest-41", "custom:worldLease": "lease-1" });
    expect(await get("/api/account.session", stale)).toMatchObject({ status: 200, data: { world: "EXPIRED", firm: null } });
    expect(await get("/api/clock.get", stale)).toMatchObject({ status: 403, error: { reason: "GUEST_WORLD_GONE" } });
  });
});

describe("[FL-111] account.usage", () => {
  it("lists every window of the world's quotas and the account's preparations", async () => {
    await consumeQuota({ client: stores.client, now: () => NOW, log: createLogger({ level: "error" }) }, "GUEST#firm-guest-41", "OUTBOUND_EMAILS");
    const usage = await get("/api/account.usage", token({ "custom:firmId": "firm-guest-41" }));
    const quotas = (usage.data as { quotas: Array<{ kind: string; window: string; used: number; limit: number }>; globalBudget: string }).quotas;
    expect(quotas).toContainEqual(expect.objectContaining({ kind: "OUTBOUND_EMAILS", window: "HOUR", used: 1, limit: GUEST_QUOTAS.OUTBOUND_EMAILS[0]?.limit }));
    expect(quotas.filter((quota) => quota.kind === "WORLD_PREPARATIONS")).toHaveLength(GUEST_QUOTAS.WORLD_PREPARATIONS.length);
    expect((usage.data as { globalBudget: string }).globalBudget).toBe("OK");
    // Without a world only the account's preparations are counted.
    expect(((await get("/api/account.usage", token())).data as { quotas: Array<{ kind: string }> }).quotas.map((quota) => quota.kind)).toEqual(["WORLD_PREPARATIONS"]);
  });

  it("is for guests only", async () => {
    expect(await get("/api/account.usage", bff.issuer.idToken())).toMatchObject({ status: 403 });
  });
});

describe("[FL-107] a guest changes its password only through recovery", () => {
  it("the session says the console offers neither a password change nor TOTP", async () => {
    expect((await get("/api/account.session", token())).data).toMatchObject({ canChangePassword: false, canSetUpMfa: false });
  });
});

describe("[FL-111] QUOTA_EXCEEDED reaches the console", () => {
  it("as HTTP 429 with the kind and the instant it resets", async () => {
    const quota = router({ spend: guestBootstrapProcedure.query(() => Promise.reject(new QuotaExceededError("CLOCK_MOVES", "2026-10-15T00:00:00.000Z"))) });
    const handler = createHandler(quota, createContextFactory(() => bff.deps, () => access), testEdgeGuard);
    const result = await call({ handler }, trpcEvent("GET", "/api/spend", { input: {}, headers: { "x-legajo-auth": `Bearer ${token()}` } }));
    expect(result).toMatchObject({ status: 429, error: { reason: "QUOTA_EXCEEDED", quota: { kind: "CLOCK_MOVES", resetsAtReal: "2026-10-15T00:00:00.000Z" } } });
  });
});
