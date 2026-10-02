// ADR-0015 §4 "Solo datos sintéticos": a guest world's registry only takes simulated mailboxes and the
// fictitious phones of its own slot's block (FL-123 (b)).
import { describe, expect, it } from "vitest";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { GUEST_FIRM, consoleCaller, serviceWorld } from "../operations-admin/testing";
import { guestPhonePattern } from "./address-rules";
import { upsertPartyHandler } from "./upsert-party";

const GUEST = consoleCaller(GUEST_FIRM, "GUEST");
const SUPPLIER = { name: "Harborline Packaging Ltd.", country: "GB", timezone: "Europe/London", language: "en" as const };
const IMPORTER = { name: "Litoral Envases SA", contactName: "Rocío Paz", contactFirstName: "Rocío", language: "es" as const };

describe("upsert_party in a guest world [FL-123]", () => {
  it("[FL-123] refuses a supplier contact outside sim.legajo.demo.craftech.io with RECIPIENT_NOT_ALLOWED and audits it", async () => {
    const world = await serviceWorld({ guestWorld: true });
    const upsert = upsertPartyHandler(world.deps);
    for (const email of ["export@harborline-packaging.co.uk", "bounce@simulator.amazonses.com", "ventas@example.com"]) {
      const answer = await upsert({ caller: GUEST, party: "SUPPLIER", data: { ...SUPPLIER, contacts: [email] } });
      expect(answer).toMatchObject({ ok: false, error: { code: "RECIPIENT_NOT_ALLOWED" } });
    }
    expect(await world.stores.connector.parties.listSuppliers(GUEST_FIRM)).toEqual([]);
    const denies = await world.stores.connector.audit.listByDecision(GUEST_FIRM, "DENY");
    expect(denies).toHaveLength(3);
    expect(denies.every((row) => row.ruleIds.includes("CP-RECIPIENT-FENCE"))).toBe(true);
  });

  it("accepts a simulated mailbox", async () => {
    const world = await serviceWorld({ guestWorld: true });
    const answer = unwrapDirect(await upsertPartyHandler(world.deps)({ caller: GUEST, party: "SUPPLIER", data: { ...SUPPLIER, contacts: ["ventas-harborline-g01@sim.legajo.demo.craftech.io"] } }));
    expect(answer).toMatchObject({ created: true, supplier: { clockId: `GUEST#${GUEST_FIRM}` }, contacts: [{ status: "ACTIVE" }] });
  });

  it("[FL-123] takes only phones of its slot's block (+54 9 11 5551 <nn>xx)", async () => {
    const world = await serviceWorld({ guestWorld: true });
    const upsert = upsertPartyHandler(world.deps);
    for (const phoneE164 of ["+5491155500150", "+5491155510250", "+14155550101"]) {
      expect(await upsert({ caller: GUEST, party: "IMPORTER", data: { ...IMPORTER, phoneE164 } })).toMatchObject({ ok: false, error: { code: "RECIPIENT_NOT_ALLOWED", reason: "GUEST_SYNTHETIC_ONLY" } });
    }
    const answer = unwrapDirect(await upsert({ caller: GUEST, party: "IMPORTER", data: { ...IMPORTER, phoneE164: "+5491155510150" } }));
    expect(answer).toMatchObject({ created: true, importer: { clockId: `GUEST#${GUEST_FIRM}` } });
  });

  it("the block of each slot, and the whole guest block for the guest-test world", () => {
    expect(guestPhonePattern("GUEST#firm-guest-31")?.test("+5491155513107")).toBe(true);
    expect(guestPhonePattern("GUEST#firm-guest-31")?.test("+5491155513207")).toBe(false);
    expect(guestPhonePattern("GLOBAL#firm-delta")).toBeUndefined();
  });
});
