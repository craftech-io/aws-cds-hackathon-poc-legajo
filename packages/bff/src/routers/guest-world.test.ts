// `account.ensureWorld` and `account.world` behind the real Lambda entry (ADR-0015 §4, FL-105, FL-110,
// FL-132): a guest token without a firm gets CREATING at once and one `GUEST_CREATE`; `world` follows
// the lease to READY; with every public slot taken the answer is CAPACITY; a staff token is refused;
// past 10 calls an hour the account gets QUOTA_EXCEEDED.
import { beforeEach, describe, expect, it } from "vitest";
import { GUEST_QUOTAS } from "@legajo/shared/guest-limits";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import { type TestAccess, testAccessDeps, testEdgeGuard } from "../signup/testing";
import { call, trpcEvent } from "../signup/testing-http";
import { leasePublicSlot, markAccountWorld, readAccountWorld } from "../worlds/guest-slots";
import { createHandler } from "./handler";
import { guestWorldProcedures } from "./guest-world";
import { createContextFactory, router } from "./trpc";
import { brokerKey } from "../connector/keys";
import { guestIdentity } from "../worlds/world-ids";

const SUB = "5a1d0c3e-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-10-14T13:30:00.000Z");
const testRouter = router({ account: router(guestWorldProcedures) });

let stores: MemoryStores;
let access: TestAccess;
let issuer: ReturnType<typeof createTestIssuer>;
let handler: ReturnType<typeof createHandler>;

beforeEach(() => {
  stores = memoryStores();
  access = testAccessDeps(stores, { now: () => NOW });
  issuer = createTestIssuer({ now: access.now });
  const deps = testContextDeps({ verifier: issuer.verifier(), stores, now: access.now });
  handler = createHandler(testRouter, createContextFactory(() => deps, () => access), testEdgeGuard);
});

function guestToken(claims: Record<string, unknown> = {}): string {
  return issuer.idToken({ sub: SUB, "cognito:username": "usr-01j9zq00000000000000000002", "custom:firmId": undefined, "custom:role": "GUEST", "custom:isGuest": "true", "cognito:groups": ["GUEST"], auth_time: Math.floor(NOW.getTime() / 1000), ...claims });
}

const headers = (token: string) => ({ "x-legajo-auth": `Bearer ${token}` });
const ensure = (token: string) => call({ handler }, trpcEvent("POST", "/api/account.ensureWorld", { input: {}, headers: headers(token) }));
const world = (token: string) => call({ handler }, trpcEvent("GET", "/api/account.world", { input: {}, headers: headers(token) }));

describe("[FL-105] account.ensureWorld", () => {
  it("answers CREATING at once, queues one GUEST_CREATE and account.world follows the lease", async () => {
    expect(await world(guestToken())).toMatchObject({ status: 200, data: { state: "NONE" } });
    expect(await ensure(guestToken())).toMatchObject({ status: 200, data: { state: "CREATING" } });
    const creates = access.invoker.invoked.filter((entry) => entry.target === "WorldJanitor");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.payload).toMatchObject({ kind: "GUEST_CREATE", sub: SUB });
    expect(await world(guestToken())).toMatchObject({ status: 200, data: { state: "CREATING" } });
    // A second visit while it is being created leases nothing more.
    expect(await ensure(guestToken())).toMatchObject({ data: { state: "CREATING" } });
    expect(access.invoker.invoked.filter((entry) => entry.target === "WorldJanitor")).toHaveLength(1);

    const lease = await readAccountWorld(access.client, SUB);
    await markAccountWorld(access.client, SUB, lease?.leaseId ?? "", { state: "READY", firmId: lease?.firmId ?? "", ...(lease?.nn === undefined ? {} : { nn: lease.nn }) }, NOW);
    // The world's broker row bound to the account (what GUEST_CREATE writes); without it the lease is a gone world.
    const firmId = lease?.firmId ?? "";
    await access.client.put("Firms", { ...brokerKey(firmId, guestIdentity(firmId).brokerId), entity: "Broker", firmId, brokerId: guestIdentity(firmId).brokerId, cognitoSub: SUB, active: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), version: 1 });
    expect(await world(guestToken())).toMatchObject({ data: { state: "READY", firmId: lease?.firmId, clockId: `GUEST#${lease?.firmId ?? ""}` } });
    expect(await ensure(guestToken())).toMatchObject({ data: { state: "READY", firmId: lease?.firmId } });
  });

  it("[FL-110] [FL-132] answers CAPACITY when the 60 public worlds are taken", async () => {
    for (let index = 0; index < 60; index += 1) await leasePublicSlot(access.client, { sub: `other-${index}`, leaseId: `lease-${index}`, now: NOW });
    expect(await ensure(guestToken())).toMatchObject({ status: 200, data: { state: "CAPACITY" } });
    expect(await world(guestToken())).toMatchObject({ data: { state: "CAPACITY" } });
    expect(access.invoker.invoked.filter((entry) => entry.target === "WorldJanitor")).toHaveLength(0);
  });

  it("[FL-111] refuses a staff token and counts the calls of an account (QUOTA_EXCEEDED past 10 an hour)", async () => {
    const staff = issuer.idToken({ sub: "staff-1", "cognito:username": "bdiego01", "custom:firmId": "firm-delta", "custom:role": "BROKER", "cognito:groups": ["BROKER"], auth_time: Math.floor(NOW.getTime() / 1000) });
    expect((await ensure(staff)).status).toBe(403);
    const limit = GUEST_QUOTAS.WORLD_PREPARATIONS[0]?.limit ?? 10;
    for (let index = 0; index < limit; index += 1) expect((await ensure(guestToken())).status).toBe(200);
    expect(await ensure(guestToken())).toMatchObject({ status: 429, error: { reason: "QUOTA_EXCEEDED" } });
  });
});
