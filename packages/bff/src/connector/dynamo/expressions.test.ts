import { describe, expect, it } from "vitest";
import { QA_DELETE_CONDITION } from "../world-conditions";
import { condition, keyCondition, updateExpression } from "./expressions";

describe("keyCondition", () => {
  it("builds a begins_with condition on the primary index", () => {
    const built = keyCondition("Operations", { hashValue: "OP#op-4471", range: { prefix: "OBS#" } });
    expect(built.expression).toBe("#n0 = :v1 AND begins_with(#n2, :v3)");
    expect(built.names).toEqual({ "#n0": "PK", "#n2": "SK" });
    expect(built.values).toEqual({ ":v1": "OP#op-4471", ":v3": "OBS#" });
    expect(built.indexName).toBeUndefined();
    expect(built.filterExpression).toBeUndefined();
  });

  it("names the GSI attributes of docs/architecture.md §5 and supports BETWEEN, <= and <", () => {
    const due = keyCondition("Operations", { index: "GSI3", hashValue: "CLOCK#GLOBAL#firm-delta", range: { lte: "2026-10-15T13:00:00.000Z" } });
    expect(due.indexName).toBe("GSI3");
    expect(due.expression).toBe("#n0 = :v1 AND #n2 <= :v3");
    expect(due.names).toEqual({ "#n0": "clockDueKey", "#n2": "dueAtSim" });
    const window = keyCondition("Conversations", { index: "GSI2", hashValue: "IMP#imp-norpampa", range: { between: ["2026-10-14T13:00:00.000Z", "2026-10-15T13:00:00.000Z"] } });
    expect(window.expression).toBe("#n0 = :v1 AND #n2 BETWEEN :v3 AND :v4");
    expect(window.names).toEqual({ "#n0": "counterpartKey", "#n2": "sentAtSim" });
    expect(keyCondition("AuditLog", { index: "GSI1", hashValue: "OP#op-4471", range: { lt: "x" } }).expression).toBe("#n0 = :v1 AND #n2 < :v3");
  });

  it("adds a filter expression with its own placeholders", () => {
    const built = keyCondition("Parties", { index: "GSI1", hashValue: "hash", filter: { equals: { entity: "Importer" }, absent: ["revokedAt"] } });
    expect(built.filterExpression).toBe("#n2 = :v3 AND attribute_not_exists(#n4)");
    expect(built.names).toMatchObject({ "#n2": "entity", "#n4": "revokedAt" });
  });

  it("rejects a range on an index without range key and an unknown index", () => {
    expect(() => keyCondition("Parties", { index: "GSI1", hashValue: "x", range: { prefix: "y" } })).toThrow(/no range key/);
    expect(() => keyCondition("Runtime", { index: "GSI1", hashValue: "x" })).toThrow(/no index/);
  });
});

describe("condition", () => {
  it("is empty without constraints", () => {
    expect(condition(undefined).expression).toBeUndefined();
    expect(condition({}).expression).toBeUndefined();
  });

  it("combines existence, optimistic locking and attribute predicates", () => {
    const built = condition({ ifExists: true, ifVersion: 3, equals: { status: "SCHEDULED" }, absent: ["closedAtReal"] });
    expect(built.expression).toBe("attribute_exists(#n0) AND #n1 = :v2 AND #n3 = :v4 AND attribute_not_exists(#n5)");
    expect(built.names).toEqual({ "#n0": "PK", "#n1": "version", "#n3": "status", "#n5": "closedAtReal" });
    expect(built.values).toEqual({ ":v2": 3, ":v4": "SCHEDULED" });
  });

  it("expresses a counter ceiling and a lapsed lease", () => {
    expect(condition({ atMost: { attribute: "presignCount", value: 19 } }).expression).toBe("(attribute_not_exists(#n0) OR #n0 <= :v1)");
    expect(condition({ ifAbsentOrExpiredAt: 1_790_000_000 }).expression).toBe("(attribute_not_exists(#n0) OR #n1 <= :v2)");
  });

  it("builds the QA delete guard: world = qa and a qa-* clock or one of the two fixed QA clocks", () => {
    const built = condition(QA_DELETE_CONDITION);
    expect(built.expression).toBe("#n0 = :v1 AND (begins_with(#n2, :v3) OR #n2 = :v4 OR #n2 = :v5)");
    expect(built.names).toEqual({ "#n0": "world", "#n2": "clockId" });
    expect(built.values).toEqual({ ":v1": "qa", ":v3": "qa-", ":v4": "GLOBAL#firm-qa", ":v5": "GUEST#firm-guest-test" });
  });

  it("refuses an empty oneOf", () => {
    expect(() => condition({ oneOf: { attribute: "clockId" } })).toThrow(/needs a prefix or a value/);
  });
});

describe("updateExpression", () => {
  it("SETs values, REMOVEs nulls, bumps the version, stamps updatedAt and requires the row", () => {
    const built = updateExpression({ set: { status: "FIRED", firedAtSim: "2026-10-15T13:00:00.000Z", clockDueKey: null, skipped: undefined } }, "2026-09-26T15:00:00.000Z", { condition: { ifVersion: 2 } });
    expect(built.expression).toBe("SET #n0 = :v1, #n2 = :v3, #n5 = :v6, #n7 = if_not_exists(#n7, :v8) + :v9 REMOVE #n4");
    expect(built.names).toMatchObject({ "#n0": "status", "#n2": "firedAtSim", "#n4": "clockDueKey", "#n5": "updatedAt", "#n7": "version" });
    expect(built.conditionExpression).toBe("attribute_exists(#n10) AND #n7 = :v11");
    expect(built.values[":v11"]).toBe(2);
  });

  it("appends to histories atomically and adds to counters and string sets", () => {
    const built = updateExpression(
      { append: { controlHistory: [{ control: "BROKER" }] }, add: { sessionEpoch: 1 }, addToSet: { inFlight: ["evt-1"] }, deleteFromSet: { done: ["evt-0"] } },
      "now",
      { upsert: true },
    );
    expect(built.expression).toBe("SET #n0 = list_append(if_not_exists(#n0, :v1), :v2), #n9 = :v10, #n11 = if_not_exists(#n11, :v12) + :v13 ADD #n3 :v4, #n5 :v6 DELETE #n7 :v8");
    expect(built.values[":v1"]).toEqual([]);
    expect(built.values[":v6"]).toEqual(new Set(["evt-1"]));
    expect(built.values[":v8"]).toEqual(new Set(["evt-0"]));
    expect(built.conditionExpression).toBeUndefined();
  });

  it("keeps the version for bookkeeping and sets creation defaults only when absent", () => {
    const built = updateExpression({ set: { scheduleName: "tm-d-x" }, setIfAbsent: { entity: "Timer" } }, "now", { keepVersion: true });
    expect(built.expression).toBe("SET #n0 = :v1, #n2 = if_not_exists(#n2, :v3), #n4 = :v5");
    expect(built.names["#n4"]).toBe("updatedAt");
    expect(Object.values(built.names)).not.toContain("version");
  });

  it("refuses to touch keys and connector-managed attributes, and the same attribute twice", () => {
    expect(() => updateExpression({ set: { PK: "x" } }, "now")).toThrow(/managed by the connector/);
    expect(() => updateExpression({ set: { version: 9 } }, "now")).toThrow(/managed by the connector/);
    expect(() => updateExpression({ set: { count: 1 }, add: { count: 1 } }, "now")).toThrow(/appears twice/);
  });
});
