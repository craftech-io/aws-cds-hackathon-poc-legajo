import { describe, expect, it } from "vitest";
import { type EscalationRow, byAge, effectiveReason, filterByReason, openFor, reasonCounts } from "./escalations-model";

function escalation(escalationId: string, reason: EscalationRow["reason"], openedAtSim: string, operationNumber = "4471"): EscalationRow {
  return { escalationId, operationId: `op-${operationNumber}`, operationNumber, reason, summary: "Revisar", status: "OPEN", openedAtSim, openedBy: "SYSTEM" };
}

const rows = [
  escalation("esc-3", "UNRECOGNIZED_DOCUMENT", "2026-10-15T10:00:00-03:00", "4477"),
  escalation("esc-1", "MISSING_AT_ETA_48H", "2026-10-17T08:00:00-03:00", "4478"),
  escalation("esc-2", "OUT_OF_CHECKLIST", "2026-10-14T11:00:00-03:00"),
  escalation("esc-4", "UNRECOGNIZED_DOCUMENT", "2026-10-15T10:00:00-03:00", "4477"),
];

describe("escalations inbox", () => {
  it("puts the one waiting longest on top", () => {
    expect(byAge(rows).map((row) => row.escalationId)).toEqual(["esc-2", "esc-3", "esc-4", "esc-1"]);
  });

  it("counts every reason with open escalations, in the order of the design, after 'Todos'", () => {
    expect(reasonCounts(rows)).toEqual([
      { reason: "ALL", count: 4 },
      { reason: "MISSING_AT_ETA_48H", count: 1 },
      { reason: "OUT_OF_CHECKLIST", count: 1 },
      { reason: "UNRECOGNIZED_DOCUMENT", count: 2 },
    ]);
    expect(reasonCounts([])).toEqual([{ reason: "ALL", count: 0 }]);
  });

  it("filters by reason and falls back to 'Todos' once the last one of a reason is resolved", () => {
    expect(filterByReason(rows, "UNRECOGNIZED_DOCUMENT").map((row) => row.escalationId)).toEqual(["esc-3", "esc-4"]);
    expect(filterByReason(rows, "ALL")).toHaveLength(4);
    expect(effectiveReason(rows, "UNRECOGNIZED_DOCUMENT")).toBe("UNRECOGNIZED_DOCUMENT");
    expect(effectiveReason(rows, "OPTED_OUT")).toBe("ALL");
  });

  it("tells how long each has been open on the simulated clock", () => {
    expect(openFor("2026-10-14T11:00:00-03:00", "2026-10-16T09:30:00-03:00")).toEqual({ days: 1, hours: 22 });
    expect(openFor("2026-10-14T11:00:00-03:00", "2026-10-14T10:00:00-03:00")).toEqual({ days: 0, hours: 0 });
    expect(openFor("2026-10-14T11:00:00-03:00", undefined)).toBeUndefined();
  });
});
