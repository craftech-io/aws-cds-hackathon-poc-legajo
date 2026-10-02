// The deterministic moments of the guest's world (docs/landing-spec.md §7.2.1, FL-129): every row of
// every moment passes the connector's schemas and keys (the seed store's own check), a moment built
// twice is the same, each moment keeps what the previous one had, and the story of 4471 follows the
// seed's ground truth (the reader's weights, the supplier's hours, the new ETA, the human approval).
import { createMemoryStores } from "@legajo/bff/connector/index";
import { describe, expect, it } from "vitest";
import { MOMENT_IDS, type MomentId, momentWorld } from "./index";

const TABLES = ["Firms", "Parties", "Operations", "Conversations", "AuditLog"] as const;

function rowsOf(world: Awaited<ReturnType<typeof momentWorld>>, entity: string, operationId = "op-4471") {
  return TABLES.flatMap((table) => world.tables[table]).filter((item) => item.entity === entity && (item.operationId === undefined || item.operationId === operationId));
}

describe("moments of the guest's world [FL-129]", () => {
  it.each(MOMENT_IDS)("builds %s with rows the connector accepts, the same twice", async (id: MomentId) => {
    const world = await momentWorld(id);
    const stores = createMemoryStores({ now: () => new Date(0) });
    expect(TABLES.flatMap((table) => stores.seed.validateItems(table, world.tables[table] as never))).toEqual([]);
    expect(JSON.stringify(await momentWorld(id))).toBe(JSON.stringify(world));
  });

  it("keeps every row of a moment in the next one, with its clock moving forward", async () => {
    const worlds = await Promise.all(MOMENT_IDS.map((id) => momentWorld(id)));
    for (let index = 1; index < worlds.length; index += 1) {
      const before = worlds[index - 1];
      const after = worlds[index];
      if (!before || !after) continue;
      expect(Date.parse(after.simNow), after.id).toBeGreaterThan(Date.parse(before.simNow));
      const messagesBefore = rowsOf(before, "Message").map((item) => item.messageId);
      const messagesAfter = new Set(rowsOf(after, "Message").map((item) => item.messageId));
      expect(messagesBefore.every((messageId) => messagesAfter.has(messageId)), after.id).toBe(true);
    }
  });

  it("starts from the template: 4471 open, two documents missing, no message yet", async () => {
    const start = await momentWorld("start");
    expect(start.simNow).toBe("2026-10-14T10:30:00-03:00");
    expect(rowsOf(start, "Message")).toEqual([]);
    expect(rowsOf(start, "Document").filter((item) => item.status === "MISSING").map((item) => item.docType).sort()).toEqual(["CERTIFICATE_OF_ORIGIN", "PACKING_LIST"]);
  });

  it("defers the email to the supplier by its hours, then reads 12,480 kg against 12,840 kg with the supplier as owner", async () => {
    const delegated = await momentWorld("after-delegate");
    const deferral = rowsOf(delegated, "Decision").find((item) => item.decision === "DEFER");
    expect(deferral).toMatchObject({ action: "SEND_EMAIL", ruleIds: ["CP-HOURS-SUPPLIER"] });
    const read = await momentWorld("after-reading");
    expect(rowsOf(read, "Observation")[0]).toMatchObject({ code: "GROSS_WEIGHT_MISMATCH", found: "12,480 kg", expected: "12,840 kg", responsibleParty: "SUPPLIER", status: "OPEN" });
  });

  it("moves the ETA to 20/10, escalates the tariff question and ends approved by a person and released", async () => {
    const moved = await momentWorld("after-eta-move");
    expect(rowsOf(moved, "Operation")[0]?.eta).toBe("2026-10-20T08:00:00-03:00");
    const escalated = await momentWorld("after-escalation");
    expect(rowsOf(escalated, "Escalation")[0]).toMatchObject({ reason: "OUT_OF_CHECKLIST", status: "OPEN" });
    const done = await momentWorld("after-dispatch");
    expect(rowsOf(done, "Operation")[0]).toMatchObject({ dossierStatus: "APPROVED", dispatch: { status: "LIBERADO" } });
    expect(rowsOf(done, "Decision").find((item) => item.action === "DOSSIER_APPROVED")?.actor).toBe("BROKER:brk-guest-00");
  });
});
