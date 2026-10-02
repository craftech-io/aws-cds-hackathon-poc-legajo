import { beforeEach, describe, expect, it } from "vitest";
import { QA_DELETE_CONDITION } from "../world-conditions";
import { MemoryTableClient } from "./table-client";

const NOW = "2026-09-26T15:00:00.000Z";

describe("MemoryTableClient", () => {
  let client: MemoryTableClient;

  beforeEach(async () => {
    client = new MemoryTableClient();
    await client.put("Parties", { PK: "IMP#imp-a", SK: "META", entity: "Importer", phoneHash: "h1", firmKey: "FIRM#firm-delta#IMP", sortName: "b", version: 1 });
    await client.put("Parties", { PK: "IMP#imp-a", SK: "CONSENT#WHATSAPP", entity: "Consent", version: 1 });
    await client.put("Parties", { PK: "IMP#imp-a", SK: "AUTH#sup-b", entity: "SupplierAuthorization", version: 1 });
    await client.put("Parties", { PK: "IMP#imp-a", SK: "AUTH#sup-a", entity: "SupplierAuthorization", version: 1 });
    await client.put("Parties", { PK: "IMP#imp-b", SK: "META", entity: "Importer", phoneHash: "h2", firmKey: "FIRM#firm-delta#IMP", sortName: "a", version: 1 });
  });

  it("gets by key and returns copies, never the stored object", async () => {
    const row = await client.get("Parties", { PK: "IMP#imp-a", SK: "META" });
    expect(row).toMatchObject({ phoneHash: "h1" });
    if (row) row.phoneHash = "mutated";
    expect((await client.get("Parties", { PK: "IMP#imp-a", SK: "META" }))?.phoneHash).toBe("h1");
  });

  it("queries the primary index by prefix in key order, descending and limited", async () => {
    const auths = await client.query("Parties", { hashValue: "IMP#imp-a", range: { prefix: "AUTH#" } });
    expect(auths.map((row) => row.SK)).toEqual(["AUTH#sup-a", "AUTH#sup-b"]);
    const last = await client.query("Parties", { hashValue: "IMP#imp-a", descending: true, limit: 1 });
    expect(last.map((row) => row.SK)).toEqual(["META"]);
  });

  it("queries GSIs, sorting by their range key, and skips rows without the index attributes (sparse)", async () => {
    expect((await client.query("Parties", { index: "GSI1", hashValue: "h2" })).map((row) => row.PK)).toEqual(["IMP#imp-b"]);
    const registry = await client.query("Parties", { index: "GSI3", hashValue: "FIRM#firm-delta#IMP" });
    expect(registry.map((row) => row.PK)).toEqual(["IMP#imp-b", "IMP#imp-a"]);
    await client.put("Operations", { PK: "OP#op-1", SK: "TIMER#MILESTONE#ARRIVAL", clockDueKey: "CLOCK#c", version: 1 });
    expect(await client.query("Operations", { index: "GSI3", hashValue: "CLOCK#c" })).toEqual([]);
    await expect(client.query("Parties", { index: "GSI1", hashValue: "h1", range: { prefix: "x" } })).rejects.toThrow(/no range key/);
  });

  it("applies range operators and filters, counting the limit after the filter", async () => {
    for (const [ts, decision] of [
      ["2026-10-14T13:00:00.000Z", "ALLOW"],
      ["2026-10-15T13:00:00.000Z", "DENY"],
      ["2026-10-16T13:00:00.000Z", "ALLOW"],
    ] as const) {
      await client.put("AuditLog", { PK: "FIRM#f#2026-10", SK: `${ts}#x`, opKey: "OP#op-1", ts, decision, version: 1 });
    }
    const query = (range: Parameters<MemoryTableClient["query"]>[1]["range"]) => client.query("AuditLog", { index: "GSI1", hashValue: "OP#op-1", ...(range ? { range } : {}) });
    expect((await query({ between: ["2026-10-15", "2026-10-16"] })).map((row) => row.decision)).toEqual(["DENY"]);
    expect(await query({ gte: "2026-10-15T13:00:00.000Z" })).toHaveLength(2);
    expect(await query({ lte: "2026-10-15T13:00:00.000Z" })).toHaveLength(2);
    expect(await query({ lt: "2026-10-15T13:00:00.000Z" })).toHaveLength(1);
    expect(await query({ eq: "2026-10-14T13:00:00.000Z" })).toHaveLength(1);
    const allowed = await client.query("AuditLog", { index: "GSI1", hashValue: "OP#op-1", filter: { equals: { decision: "ALLOW" } }, descending: true, limit: 1 });
    expect(allowed.map((row) => row.ts)).toEqual(["2026-10-16T13:00:00.000Z"]);
  });

  it("enforces ifNotExists, ifExists, ifVersion and attribute predicates with CONFLICT", async () => {
    const key = { PK: "IMP#imp-a", SK: "META" };
    await expect(client.put("Parties", { ...key, version: 1 }, { ifNotExists: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.put("Parties", { PK: "IMP#none", SK: "META", version: 1 }, { ifExists: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.put("Parties", { ...key, version: 2 }, { ifVersion: 7 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.delete("Parties", key, { equals: { entity: "Consent" } })).rejects.toMatchObject({ code: "CONFLICT" });
    await client.delete("Parties", key, { equals: { entity: "Importer" }, absent: ["revokedAt"] });
    expect(await client.get("Parties", key)).toBeUndefined();
  });

  it("updates with SET, REMOVE, list appends and counters, bumps the version and reports NOT_FOUND", async () => {
    const key = { PK: "IMP#imp-a", SK: "META" };
    const updated = await client.update("Parties", key, { set: { name: "N", phoneHash: null }, append: { history: [{ a: 1 }] }, add: { hits: 2 } }, NOW, { condition: { ifVersion: 1 } });
    expect(updated).toMatchObject({ name: "N", version: 2, updatedAt: NOW, history: [{ a: 1 }], hits: 2 });
    expect(updated.phoneHash).toBeUndefined();
    const again = await client.update("Parties", key, { append: { history: [{ a: 2 }] }, add: { hits: 1 } }, NOW);
    expect(again).toMatchObject({ version: 3, history: [{ a: 1 }, { a: 2 }], hits: 3 });
    await expect(client.update("Parties", { PK: "IMP#none", SK: "META" }, { set: { a: 1 } }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.update("Parties", key, { set: { a: 1 } }, NOW, { condition: { ifVersion: 1 } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await client.update("Parties", key, { set: { scheduleName: "x" } }, NOW, { keepVersion: true })).version).toBe(3);
  });

  it("upserts counters and string sets; an emptied set disappears like in DynamoDB", async () => {
    const key = { PK: "OPSTATE#op-1", SK: "META" };
    const first = await client.update("Runtime", key, { addToSet: { inFlight: ["e1", "e2"] }, setIfAbsent: { entity: "OpState" } }, NOW, { upsert: true });
    expect(first).toMatchObject({ entity: "OpState", version: 1 });
    expect([...(first.inFlight as Set<string>)]).toEqual(["e1", "e2"]);
    await client.update("Runtime", key, { addToSet: { inFlight: ["e1"] } }, NOW);
    const emptied = await client.update("Runtime", key, { deleteFromSet: { inFlight: ["e1", "e2"] }, setIfAbsent: { entity: "Other" } }, NOW);
    expect(emptied.inFlight).toBeUndefined();
    expect(emptied.entity).toBe("OpState");
  });

  it("honours a counter ceiling and a lapsed lease", async () => {
    const link = { PK: "LINK#t", SK: "META" };
    await client.put("Runtime", { ...link, presignCount: 19, version: 1 });
    await client.update("Runtime", link, { add: { presignCount: 1 } }, NOW, { condition: { atMost: { attribute: "presignCount", value: 19 } } });
    await expect(client.update("Runtime", link, { add: { presignCount: 1 } }, NOW, { condition: { atMost: { attribute: "presignCount", value: 19 } } })).rejects.toMatchObject({ code: "CONFLICT" });
    const lease = { PK: "LEASE#OPNUM#7001", SK: "META" };
    await client.put("Runtime", { ...lease, holder: "a", expiresAt: 1000, version: 1 }, { ifAbsentOrExpiredAt: 999 });
    await expect(client.put("Runtime", { ...lease, holder: "b", version: 1 }, { ifAbsentOrExpiredAt: 999 })).rejects.toMatchObject({ code: "CONFLICT" });
    await client.put("Runtime", { ...lease, holder: "b", version: 1 }, { ifAbsentOrExpiredAt: 1000 });
    expect((await client.get("Runtime", lease))?.holder).toBe("b");
  });

  it("only deletes QA items of QA clocks under the QA guard", async () => {
    const qa = { PK: "OP#op-7001", SK: "META" };
    await client.put("Operations", { ...qa, world: "qa", clockId: "qa-812-1-sc16", version: 1 });
    await client.put("Operations", { PK: "OP#op-4471", SK: "META", clockId: "GLOBAL#firm-delta", version: 1 });
    await client.put("Operations", { PK: "OP#op-4471-q", SK: "META", world: "qa", clockId: "GLOBAL#firm-qa", version: 1 });
    await expect(client.delete("Operations", { PK: "OP#op-4471", SK: "META" }, QA_DELETE_CONDITION)).rejects.toMatchObject({ code: "CONFLICT" });
    await client.delete("Operations", qa, QA_DELETE_CONDITION);
    await client.delete("Operations", { PK: "OP#op-4471-q", SK: "META" }, QA_DELETE_CONDITION);
    expect(client.dump("Operations").map((row) => row.PK)).toEqual(["OP#op-4471"]);
  });

  it("rolls back a whole transaction when one condition (a check included) fails", async () => {
    await expect(
      client.transact([
        { op: "put", table: "Operations", item: { PK: "OP#op-1", SK: "META", version: 1 }, condition: { ifNotExists: true } },
        { op: "update", table: "Parties", key: { PK: "IMP#imp-b", SK: "META" }, spec: { set: { name: "x" } }, updatedAt: NOW },
        { op: "check", table: "Runtime", key: { PK: "TOMB#c#1", SK: "META" }, condition: { ifExists: true } },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await client.get("Operations", { PK: "OP#op-1", SK: "META" })).toBeUndefined();
    expect((await client.get("Parties", { PK: "IMP#imp-b", SK: "META" }))?.name).toBeUndefined();
  });

  it("writes and deletes in batches", async () => {
    await client.batchPut("Reference", [
      { PK: "REF#HOLIDAY#AR", SK: "2026-10-12", version: 1 },
      { PK: "REF#HOLIDAY#AR", SK: "2026-11-23", version: 1 },
    ]);
    expect(client.dump("Reference")).toHaveLength(2);
    await client.batchDelete("Reference", [{ PK: "REF#HOLIDAY#AR", SK: "2026-10-12" }]);
    expect(client.dump("Reference").map((row) => row.SK)).toEqual(["2026-11-23"]);
  });

  it("linkOnly answers like an unlinked Resource: UNAVAILABLE outside the linked tables, recorded even when caught; dump stays open", async () => {
    client.linkOnly(["Parties"]);
    expect(await client.get("Parties", { PK: "IMP#imp-a", SK: "META" })).toBeDefined();
    await expect(client.get("Firms", { PK: "FIRM#firm-delta", SK: "META" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(client.transact([{ op: "check", table: "Operations", key: { PK: "OP#op-1", SK: "META" }, condition: { ifExists: true } }])).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(client.dump("Reference")).toEqual([]);
    expect(client.unlinkedAccesses).toEqual(["Firms", "Operations"]);
    client.linkOnly(undefined);
    expect(await client.get("Firms", { PK: "FIRM#firm-delta", SK: "META" })).toBeUndefined();
  });
});
