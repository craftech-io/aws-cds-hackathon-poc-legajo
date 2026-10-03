// FL-123: a guest works only on synthetic data of its own guest firm (ADR-0015 §4 "Solo datos sintéticos").
import { describe, expect, it } from "vitest";
import { CLOCK, FIRM, OPERATION } from "../services/operations-admin/testing";
import { GUEST, GUEST_CLOCK, consoleServiceWorld, guestOperation } from "./console-testing";
import { GUEST_FIRM } from "./testing";

describe("a guest's console [FL-123]", () => {
  it("[FL-123] (a) reading or changing a demo firm's data is 403 CROSS_FIRM, audited in the guest's own firm", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    const guest = world.caller(GUEST);
    await expect(guest.operations.get({ operationId: OPERATION })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guest.clock.get({ clockId: CLOCK })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guest.registry.importers.list({ clockId: CLOCK })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guest.conversation.take({ operationId: OPERATION })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guest.simulator.sendText({ importerId: "imp-norpampa", text: "Hola" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guest.clock.moveEta({ operationId: OPERATION, eta: "2026-10-26T08:00:00-03:00" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const denies = await world.stores.connector.audit.listByDecision(GUEST_FIRM, "DENY");
    expect(denies.length).toBeGreaterThanOrEqual(6);
    expect(denies.every((row) => row.action === "CROSS_FIRM")).toBe(true);
    expect(await world.stores.connector.audit.listByDecision(FIRM, "DENY")).toEqual([]);
    expect((await world.stores.connector.operations.getOperation(OPERATION)).control).toBe("AGENT");
    expect(world.envelopes).toEqual([]);
    expect(world.feeds).toEqual([]);
  });

  it("[FL-123] (b) the guest world's registry takes only simulated mailboxes and phones of its slot's block (RECIPIENT_NOT_ALLOWED, audited)", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    const guest = world.caller(GUEST);
    const supplier = { name: "Harborline Packaging Ltd.", country: "GB", timezone: "Europe/London", language: "en" as const };
    await expect(guest.registry.suppliers.upsert({ ...supplier, contacts: ["export@harborline-packaging.co.uk"] })).rejects.toMatchObject({ code: "FORBIDDEN", cause: { code: "RECIPIENT_NOT_ALLOWED" } });
    await expect(guest.registry.suppliers.upsert({ ...supplier, contacts: ["ventas@example.com"] })).rejects.toMatchObject({ cause: { code: "RECIPIENT_NOT_ALLOWED" } });
    const importer = { name: "Litoral Envases SA", contactName: "Rocío Paz", contactFirstName: "Rocío", language: "es" as const };
    await expect(guest.registry.importers.upsert({ ...importer, phoneE164: "+14155550101" })).rejects.toMatchObject({ cause: { code: "RECIPIENT_NOT_ALLOWED", reason: "GUEST_SYNTHETIC_ONLY" } });
    await expect(guest.registry.importers.upsert({ ...importer, phoneE164: "+5491155500150" })).rejects.toMatchObject({ cause: { code: "RECIPIENT_NOT_ALLOWED" } });
    expect(await world.stores.connector.parties.listSuppliers(GUEST_FIRM)).toEqual([]);
    const denies = await world.stores.connector.audit.listByDecision(GUEST_FIRM, "DENY");
    expect(denies.filter((row) => row.ruleIds.includes("CP-RECIPIENT-FENCE"))).toHaveLength(4);
  });

  it("[FL-123] (c) the guest's own world works end to end on synthetic parties: its operation, its phone, its quotas", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    const { operationId, importerId } = await guestOperation(world);
    const guest = world.caller(GUEST);
    expect((await guest.operations.list({})).operations.map((operation) => operation.operationId)).toEqual([operationId]);
    await guest.simulator.sendText({ importerId, text: "Hola" });
    expect(world.envelopes).toHaveLength(1);
    expect((await guest.clock.get({})).clockId).toBe(GUEST_CLOCK);
  });
});
