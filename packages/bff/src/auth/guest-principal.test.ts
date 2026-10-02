// FL-109, ADR-0015 §4: a guest's token acts only on the world its broker row still names. The row found
// by `SUB#<sub>` must exist, be active, carry the token's firm and its world lease; a token issued for
// a world that was destroyed, or for a slot leased again (by another account or by the same one), gets
// 403 `GUEST_WORLD_GONE` on every procedure with a firm, at once (the row is never cached for a guest).
import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { type Bff, bffFor, call, trpcEvent } from "../signup/testing-http";
import { guestRowRefusal } from "./principal";
import { seedBrokers } from "./testing";

const FIRM = "firm-guest-41";
const OWNER = "5a1d0c3e-0000-4000-8000-000000000041";
const NEXT_OWNER = "5a1d0c3e-0000-4000-8000-000000000042";

let stores: MemoryStores;
let access: TestAccess;
let bff: Bff;

beforeEach(async () => {
  stores = memoryStores();
  access = testAccessDeps(stores);
  bff = bffFor(stores, access);
  await writeRow(OWNER, "lease-1");
});

async function writeRow(sub: string, leaseId: string): Promise<void> {
  await seedBrokers(stores, [{ firmId: FIRM, brokerId: "brk-guest-41", role: "GUEST", sub }]);
  await stores.client.update("Firms", { PK: `FIRM#${FIRM}`, SK: "BROKER#brk-guest-41" }, { set: { leaseId } }, new Date().toISOString());
}

function guestToken(sub: string, worldLease: string | undefined): string {
  return bff.issuer.idToken({ sub, "cognito:username": `usr-${sub.slice(0, 8)}`, "custom:firmId": FIRM, "custom:role": "GUEST", "custom:isGuest": "true", "cognito:groups": ["GUEST"], "custom:worldLease": worldLease });
}

const clockGet = (token: string) => call(bff, trpcEvent("GET", "/api/clock.get", { input: {}, headers: { "x-legajo-auth": `Bearer ${token}` } }));

describe("[FL-109] the principal of a guest fails closed", () => {
  it("acts while its row names its firm and its lease", async () => {
    expect((await clockGet(guestToken(OWNER, "lease-1"))).error?.reason).not.toBe("GUEST_WORLD_GONE");
  });

  it("an old token after its world was destroyed: 403", async () => {
    const token = guestToken(OWNER, "lease-1");
    await stores.client.delete("Firms", { PK: `FIRM#${FIRM}`, SK: "BROKER#brk-guest-41" });
    expect(await clockGet(token)).toMatchObject({ status: 403, error: { reason: "GUEST_WORLD_GONE" } });
  });

  it("an old token after the same slot was leased again by another account: 403", async () => {
    const token = guestToken(OWNER, "lease-1");
    await stores.client.delete("Firms", { PK: `FIRM#${FIRM}`, SK: "BROKER#brk-guest-41" });
    await writeRow(NEXT_OWNER, "lease-2");
    expect(await clockGet(token)).toMatchObject({ status: 403, error: { reason: "GUEST_WORLD_GONE" } });
    expect((await clockGet(guestToken(NEXT_OWNER, "lease-2"))).error?.reason).not.toBe("GUEST_WORLD_GONE");
  });

  it("an old token of the same account whose world was created again in the same slot: 403 until it refreshes", async () => {
    const token = guestToken(OWNER, "lease-1");
    await stores.client.update("Firms", { PK: `FIRM#${FIRM}`, SK: "BROKER#brk-guest-41" }, { set: { leaseId: "lease-3" } }, new Date().toISOString());
    expect(await clockGet(token)).toMatchObject({ status: 403, error: { reason: "GUEST_WORLD_GONE" } });
    expect((await clockGet(guestToken(OWNER, "lease-3"))).error?.reason).not.toBe("GUEST_WORLD_GONE");
  });

  it("an inactive row and a row of another firm are refused too", () => {
    expect(guestRowRefusal({ firmId: FIRM, worldLease: "l" }, { firmId: FIRM, active: false, leaseId: "l" })).toBe("INACTIVE");
    expect(guestRowRefusal({ firmId: FIRM, worldLease: "l" }, { firmId: "firm-guest-42", active: true, leaseId: "l" })).toBe("OTHER_FIRM");
    expect(guestRowRefusal({ firmId: FIRM, worldLease: "l" }, undefined)).toBe("NO_ROW");
    expect(guestRowRefusal({ firmId: FIRM, worldLease: "l" }, { firmId: FIRM, active: true })).toBe("OTHER_LEASE");
    expect(guestRowRefusal({ firmId: FIRM, worldLease: "l" }, { firmId: FIRM, active: true, leaseId: "l" })).toBeUndefined();
  });
});
