// ADR-0015 §4: a guest world creates at most 10 operations a real day (`NEW_OPERATIONS`); past it,
// `QUOTA_EXCEEDED {kind, resetsAtReal}` and nothing written. Demo worlds have no quota.
import { describe, expect, it } from "vitest";
import { hashOf } from "../../connector/testing";
import { createOperationHandler } from "./create-operation";
import { unwrapDirect } from "./handler-kit";
import { FIRM, GUEST_CLOCK, GUEST_FIRM, type ServiceWorld, consoleCaller, platformRow, serviceWorld } from "./testing";

const GUEST = consoleCaller(GUEST_FIRM, "GUEST");

async function guestParties(world: ServiceWorld): Promise<void> {
  const { parties } = world.stores.connector;
  const phone = "+5491155510101";
  await parties.createImporter({ importerId: "imp-litoral", firmId: GUEST_FIRM, clockId: GUEST_CLOCK, name: "Litoral Envases SA", contactName: "Rocío Paz", contactFirstName: "Rocío", phoneE164: phone, phoneHash: hashOf(phone), language: "es" });
  await parties.createSupplier({ supplierId: "sup-harbor", firmId: GUEST_FIRM, clockId: GUEST_CLOCK, name: "Harborline Packaging Ltd.", country: "GB", timezone: "Europe/London", language: "en", behaviour: "PROMPT", behaviourParams: {} });
  for (let index = 0; index < 12; index += 1) {
    const number = String(7101 + index);
    world.platform.set(`${GUEST_FIRM}#${number}`, platformRow(GUEST_FIRM, number, { importerId: "imp-litoral", supplierId: "sup-harbor" }));
  }
}

describe("create_operation in a guest world", () => {
  it("spends one NEW_OPERATIONS per operation and refuses the eleventh of the day with QUOTA_EXCEEDED and its renewal", async () => {
    const world = await serviceWorld({ guestWorld: true });
    await guestParties(world);
    const create = createOperationHandler(world.deps);
    for (let index = 0; index < 10; index += 1) {
      const answer = unwrapDirect(await create({ caller: GUEST, operationNumber: String(7101 + index) }));
      expect(answer.operationId).toBe(`op-${7101 + index}-g01`);
    }
    const refused = await create({ caller: GUEST, operationNumber: "7111" });
    expect(refused).toMatchObject({ ok: false, error: { code: "POLICY_DENIED", reason: "QUOTA_EXCEEDED" }, quota: { kind: "NEW_OPERATIONS", resetsAtReal: expect.any(String) } });
    if (!refused.ok) expect(Date.parse(refused.quota?.resetsAtReal ?? "")).toBeGreaterThan(Date.parse("2026-09-26T15:00:00.000Z"));
    expect(await world.stores.connector.operations.findOperation("op-7111-g01")).toBeUndefined();
    expect(world.metrics("QuotaHits")).toHaveLength(1);
  });

  it("renews the next real day", async () => {
    const world = await serviceWorld({ guestWorld: true });
    await guestParties(world);
    const create = createOperationHandler(world.deps);
    for (let index = 0; index < 10; index += 1) unwrapDirect(await create({ caller: GUEST, operationNumber: String(7101 + index) }));
    world.advanceReal(24 * 60 * 60 * 1000);
    expect(unwrapDirect(await create({ caller: GUEST, operationNumber: "7111" })).operationId).toBe("op-7111-g01");
  });

  it("a refusal before the quota (an unknown number) spends nothing, and a demo world has no quota", async () => {
    const world = await serviceWorld({ guestWorld: true });
    await guestParties(world);
    const create = createOperationHandler(world.deps);
    for (let index = 0; index < 3; index += 1) expect(await create({ caller: GUEST, operationNumber: "7199" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    for (let index = 0; index < 10; index += 1) unwrapDirect(await create({ caller: GUEST, operationNumber: String(7101 + index) }));
    for (let index = 0; index < 12; index += 1) {
      const number = String(4481 + index);
      world.platform.set(`${FIRM}#${number}`, platformRow(FIRM, number));
      unwrapDirect(await create({ caller: consoleCaller(), operationNumber: number }));
    }
  });
});
