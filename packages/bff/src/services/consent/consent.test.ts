import { describe, expect, it } from "vitest";
import { derivedEventId } from "../../channels/adapter";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { CLOCK, FIRM, consoleCaller, serviceWorld } from "../operations-admin/testing";
import { authorizeSupplierContactHandler } from "./authorization";
import { recordConsentHandler, revokeConsentHandler } from "./consent";

const GRANTED_AT = "2026-10-01T09:00:00-03:00";
const WAMID = "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFjNFQjBDQUZFMDAwMDAwMDAwMDAwMQA=";

describe("record_consent [FL-001]", () => {
  it("[FL-001] records the opt-in with its date, medium and text version, and audits CONSENT_GRANTED", async () => {
    const world = await serviceWorld();
    const record = recordConsentHandler(world.deps);
    const answer = unwrapDirect(await record({ caller: consoleCaller(), importerId: "imp-norpampa", medium: "SIGNED_FORM", grantedAt: GRANTED_AT, textVersion: "v1" }));
    expect(answer.consent).toMatchObject({ status: "GRANTED", medium: "SIGNED_FORM", textVersion: "v1" });
    const consent = await world.stores.connector.parties.getConsent("imp-norpampa");
    expect(consent?.history).toHaveLength(1);
    const audit = await world.stores.connector.audit.listByDecision(FIRM, "ACTION");
    expect(audit.map((row) => row.action)).toContain("CONSENT_GRANTED");
  });

  it("refuses an opt-in dated after the world's now, an unknown text version and a date without zone", async () => {
    const world = await serviceWorld();
    const record = recordConsentHandler(world.deps);
    const future = await record({ caller: consoleCaller(), importerId: "imp-norpampa", medium: "EMAIL", grantedAt: "2026-12-01T09:00:00-03:00", textVersion: "v1" });
    expect(future).toMatchObject({ ok: false, error: { code: "INVALID", reason: "GRANTED_AT_FUTURE" } });
    const version = await record({ caller: consoleCaller(), importerId: "imp-norpampa", medium: "EMAIL", grantedAt: GRANTED_AT, textVersion: "v9" });
    expect(version).toMatchObject({ ok: false, error: { reason: "UNKNOWN_TEXT_VERSION" } });
    expect(await world.stores.connector.parties.getConsent("imp-norpampa")).toBeUndefined();
  });

  it("[FL-082] refuses an importer of another firm with 403 and DENY CROSS_FIRM in the caller's firm", async () => {
    const world = await serviceWorld();
    const record = recordConsentHandler(world.deps);
    const answer = await record({ caller: consoleCaller("firm-norte"), importerId: "imp-norpampa", medium: "EMAIL", grantedAt: GRANTED_AT, textVersion: "v1" });
    expect(answer).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "CROSS_FIRM" } });
    const denies = await world.stores.connector.audit.listByDecision("firm-norte", "DENY");
    expect(denies.map((row) => row.action)).toEqual(["CROSS_FIRM"]);
    expect(await world.stores.connector.parties.getConsent("imp-norpampa")).toBeUndefined();
  });
});

describe("revoke_consent [FL-006] [FL-016]", () => {
  it("[FL-006] revokes from the console: revokedAt and history, nothing sent to the importer", async () => {
    const world = await serviceWorld();
    unwrapDirect(await recordConsentHandler(world.deps)({ caller: consoleCaller(), importerId: "imp-norpampa", medium: "IN_PERSON", grantedAt: GRANTED_AT, textVersion: "v1" }));
    const answer = unwrapDirect(await revokeConsentHandler(world.deps)({ caller: consoleCaller(), importerId: "imp-norpampa", reason: "pidió la baja por teléfono" }));
    expect(answer).toMatchObject({ revoked: true, consent: { status: "REVOKED" }, confirmed: false, escalated: 0 });
    expect(world.events).toEqual([]);
    const consent = await world.stores.connector.parties.getConsent("imp-norpampa");
    expect(consent?.history.map((entry) => entry.action)).toEqual(["GRANTED", "REVOKED"]);
  });

  it("[FL-016] from the channel: the fixed confirmation answers the importer and every open operation escalates OPTED_OUT, once per wamid", async () => {
    const world = await serviceWorld();
    unwrapDirect(await recordConsentHandler(world.deps)({ caller: consoleCaller(), importerId: "imp-norpampa", medium: "SIGNED_FORM", grantedAt: GRANTED_AT, textVersion: "v1" }));
    const revoke = revokeConsentHandler(world.deps);
    const input = { caller: { kind: "CHANNEL" as const, firmId: FIRM }, importerId: "imp-norpampa", clockId: CLOCK, channel: { operationIds: ["op-4471"], messageId: "msg-inoptout1", wamid: WAMID, atSim: "2026-10-14T10:30:00-03:00", via: "BUTTON" as const } };
    const first = unwrapDirect(await revoke(input));
    expect(first).toMatchObject({ revoked: true, confirmed: true, escalated: 1 });
    expect(world.events.map((event) => event.type)).toEqual(["OUTBOUND_SEND", "ESCALATE"]);
    expect(world.events[0]).toMatchObject({ kind: "OPT_OUT_CONFIRMATION", author: "SYSTEM", channel: "WHATSAPP", inReplyToMessageId: "msg-inoptout1", eventId: derivedEventId("OUTBOUND_SEND", `${WAMID}#OPT_OUT_CONFIRMATION`) });
    expect(world.events[1]).toMatchObject({ reason: "OPTED_OUT", operationId: "op-4471" });
    const again = unwrapDirect(await revoke(input));
    expect(again.revoked).toBe(false);
    expect(world.events.slice(2).map((event) => event.eventId)).toEqual(world.events.slice(0, 2).map((event) => event.eventId));
  });

  it("only the channel brings the importer's message", async () => {
    const world = await serviceWorld();
    const answer = await revokeConsentHandler(world.deps)({ caller: consoleCaller(), importerId: "imp-norpampa", channel: { operationIds: [], messageId: "msg-in1", wamid: WAMID, atSim: "2026-10-14T10:30:00-03:00", via: "KEYWORD" } });
    expect(answer).toMatchObject({ ok: false, error: { code: "INVALID", reason: "CHANNEL_ORIGIN" } });
  });
});

describe("authorize_supplier_contact [FL-003] [FL-006]", () => {
  it("[FL-003] authorizes with the broker and its date, does nothing when unchanged, and [FL-006] revokes with history", async () => {
    const world = await serviceWorld();
    const authorize = authorizeSupplierContactHandler(world.deps);
    const on = unwrapDirect(await authorize({ caller: consoleCaller(), importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true }));
    expect(on).toMatchObject({ authorized: true, brokerId: "brk-delta-diego", changed: true });
    expect(unwrapDirect(await authorize({ caller: consoleCaller(), importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true })).changed).toBe(false);
    const off = unwrapDirect(await authorize({ caller: consoleCaller("firm-delta", "ANALYST"), importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: false }));
    expect(off).toMatchObject({ authorized: false, changed: true });
    const actions = (await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).map((row) => row.action);
    expect(actions).toEqual(["SUPPLIER_CONTACT_AUTHORIZED", "SUPPLIER_CONTACT_REVOKED"]);
  });

  it("refuses a supplier of another firm", async () => {
    const world = await serviceWorld();
    const answer = await authorizeSupplierContactHandler(world.deps)({ caller: consoleCaller("firm-norte"), importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true });
    expect(answer).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});
