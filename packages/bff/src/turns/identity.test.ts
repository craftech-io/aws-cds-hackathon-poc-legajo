import { describe, expect, it } from "vitest";
import { harnessIdentity } from "./identity";

describe("the importer's conversation session (ADR-0017)", () => {
  const key = new TextEncoder().encode("k".repeat(32)) as never;
  const base = { clockId: "GLOBAL#firm-delta", importerId: "imp-norpampa", worldEpoch: 3, sessionEpoch: 0 };
  it("is one session for every operation of the importer, apart from each operation's own", () => {
    const a = harnessIdentity(key, { ...base, operationId: "op-4471" }, "IMPORTER_MESSAGE");
    const b = harnessIdentity(key, { ...base, operationId: "op-4478" }, "IMPORTER_MESSAGE");
    expect(a.runtimeSessionId).toBe(b.runtimeSessionId);
    expect(a.actorId).toBe("imp-norpampa-e3");
    expect(harnessIdentity(key, { ...base, operationId: "op-4471" }, "SUPPLIER_EMAIL").runtimeSessionId).not.toBe(a.runtimeSessionId);
    expect(harnessIdentity(key, { ...base, operationId: "op-4471" }).runtimeSessionId).toBe(harnessIdentity(key, { ...base, operationId: "op-4471" }, "MILESTONE").runtimeSessionId);
    expect(harnessIdentity(key, { ...base, operationId: "op-4471", sessionEpoch: 1 }, "IMPORTER_MESSAGE").runtimeSessionId).not.toBe(a.runtimeSessionId);
  });
});
