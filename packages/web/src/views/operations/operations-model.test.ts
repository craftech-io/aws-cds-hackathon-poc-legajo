import type { DocStatus, DossierStatus } from "@legajo/shared";
import { describe, expect, it } from "vitest";
import type { OperationRow } from "../dossier/types";
import {
  CLOCK_NEXT_EVENTS_LIMIT,
  NO_FILTERS,
  type NextEvent,
  applyFilters,
  listRows,
  nextEventOf,
  riskCounts,
  statusCounts,
  upcomingOf,
} from "./operations-model";

const SIM_NOW = "2026-10-14T10:30:00-03:00";

function operation(number: string, overrides: { eta?: string; dossierStatus?: DossierStatus; docs?: readonly DocStatus[] } = {}): OperationRow {
  const [ci = "MISSING", pl = "MISSING", co = "MISSING"] = overrides.docs ?? [];
  return {
    operationId: `op-${number}`,
    operationNumber: number,
    clockId: "GLOBAL#firm-delta",
    importerId: "imp-norpampa",
    supplierId: "sup-qingdao",
    vessel: "Austral Aurora",
    carrier: "Austral Line",
    portOfLoading: "Qingdao",
    portOfDischarge: "Buenos Aires",
    eta: overrides.eta ?? "2026-10-22T08:00:00-03:00",
    dossierStatus: overrides.dossierStatus ?? "OPEN",
    control: "AGENT",
    dispatch: { status: "NONE" },
    openedAtSim: SIM_NOW,
    importerName: "Norpampa Insumos SRL",
    supplierName: "Qingdao Bluewave Textiles Co., Ltd.",
    documents: [
      { docType: "COMMERCIAL_INVOICE", status: ci, currentVersion: 0 },
      { docType: "PACKING_LIST", status: pl, currentVersion: 0 },
      { docType: "CERTIFICATE_OF_ORIGIN", status: co, currentVersion: 0 },
    ],
    openEscalations: 0,
    processError: false,
  };
}

function event(number: string, dueAtSim: string, timerId = "DOCS_REQUEST"): NextEvent {
  return { operationNumber: number, kind: "MILESTONE", timerId, dueAtSim };
}

describe("operations list model", () => {
  it("pins the 4471 on top as the main story and orders the rest by ETA, naming the second-act stories", () => {
    const rows = listRows(
      [
        operation("4478", { eta: "2026-10-19T08:00:00-03:00" }),
        operation("4474", { eta: "2026-10-24T08:00:00-03:00" }),
        operation("4471", { eta: "2026-10-22T08:00:00-03:00" }),
        operation("4472", { eta: "2026-10-23T08:00:00-03:00" }),
      ],
      SIM_NOW,
      undefined,
    );
    expect(rows.map((row) => row.row.operationNumber)).toEqual(["4471", "4478", "4472", "4474"]);
    expect(rows.map((row) => row.mainStory)).toEqual([true, false, false, false]);
    expect(rows.map((row) => row.secondAct)).toEqual([undefined, "4478", undefined, "4474"]);
  });

  it("reads time to arrival and risk on the world's simulated clock, never the machine's", () => {
    const [row] = listRows([operation("4471")], SIM_NOW, undefined);
    expect(row?.toEta).toEqual({ arrived: false, days: 7, hours: 21, minutes: 30 });
    expect(row?.risk).toBe("ON_TRACK");
    const [late] = listRows([operation("4471")], "2026-10-19T08:00:00-03:00", undefined);
    expect(late?.risk).toBe("AT_RISK");
    const [arrived] = listRows([operation("4471")], "2026-10-22T09:00:00-03:00", undefined);
    expect(arrived?.toEta?.arrived).toBe(true);
    const [unknown] = listRows([operation("4471")], undefined, undefined);
    expect(unknown?.risk).toBeUndefined();
    expect(unknown?.toEta).toBeUndefined();
  });

  it("calls a dossier complete when it is ready for review, approved, or its three documents are valid", () => {
    const late = "2026-10-21T08:00:00-03:00";
    const rows = listRows(
      [operation("4488", { dossierStatus: "READY_FOR_REVIEW" }), operation("4487", { dossierStatus: "APPROVED" }), operation("4471", { docs: ["VALID", "VALID", "VALID"] }), operation("4472", { docs: ["VALID", "VALID", "WITH_OBSERVATION"] })],
      late,
      undefined,
    );
    expect(Object.fromEntries(rows.map((row) => [row.row.operationNumber, row.risk]))).toEqual({ "4488": "COMPLETE", "4487": "COMPLETE", "4471": "COMPLETE", "4472": "AT_RISK" });
  });
});

describe("next event of an operation", () => {
  it("parses the world's next events out of clock.get, earliest first", () => {
    const upcoming = upcomingOf({ clockId: "GLOBAL#firm-delta", nextEvents: [event("4474", "2026-10-17T10:00:00-03:00"), event("4471", "2026-10-15T10:00:00-03:00")] });
    expect(upcoming?.events.map((item) => item.operationNumber)).toEqual(["4471", "4474"]);
    expect(upcoming?.complete).toBe(true);
    expect(upcomingOf(undefined)).toBeUndefined();
    expect(upcomingOf({ nextEvents: [{ operationNumber: "op-4471" }] })).toBeUndefined();
  });

  it("shows the operation's own event, 'after the last one' when the list is cut, nothing when the list is whole", () => {
    const full = Array.from({ length: CLOCK_NEXT_EVENTS_LIMIT }, (_, index) => event("4471", `2026-10-1${5 + index}T10:00:00-03:00`, "FOLLOWUP"));
    const cut = upcomingOf({ nextEvents: full });
    expect(nextEventOf("4471", cut)).toEqual({ kind: "event", event: full[0] });
    expect(nextEventOf("4474", cut)).toEqual({ kind: "later", after: "2026-10-19T10:00:00-03:00" });
    expect(nextEventOf("4474", upcomingOf({ nextEvents: [event("4471", "2026-10-15T10:00:00-03:00")] }))).toEqual({ kind: "none" });
    expect(nextEventOf("4471", undefined)).toEqual({ kind: "unknown" });
  });
});

describe("filters by status, risk and ETA range", () => {
  const rows = listRows(
    [
      operation("4471"),
      operation("4478", { eta: "2026-10-16T08:00:00-03:00" }),
      operation("4488", { dossierStatus: "READY_FOR_REVIEW", eta: "2026-10-18T08:00:00-03:00" }),
      operation("4487", { dossierStatus: "APPROVED", eta: "2026-10-16T07:00:00-03:00" }),
    ],
    SIM_NOW,
    undefined,
  );

  it("filters by dossier status, risk and the calendar date of the ETA in Argentina", () => {
    const numbers = (filters: Parameters<typeof applyFilters>[1]) => applyFilters(rows, filters).map((row) => row.row.operationNumber);
    expect(numbers(NO_FILTERS)).toEqual(["4471", "4487", "4478", "4488"]);
    expect(numbers({ ...NO_FILTERS, status: "APPROVED" })).toEqual(["4487"]);
    expect(numbers({ ...NO_FILTERS, risk: "AT_RISK" })).toEqual(["4478"]);
    expect(numbers({ ...NO_FILTERS, risk: "COMPLETE" })).toEqual(["4487", "4488"]);
    expect(numbers({ ...NO_FILTERS, eta: { from: "2026-10-17", to: "2026-10-22" } })).toEqual(["4471", "4488"]);
  });

  it("counts, for every option, the rows it would show with the other filters as they are", () => {
    expect(statusCounts(rows, NO_FILTERS)).toEqual({ ALL: 4, OPEN: 2, READY_FOR_REVIEW: 1, APPROVED: 1, REOPENED: 0 });
    expect(riskCounts(rows, NO_FILTERS)).toEqual({ ALL: 4, AT_RISK: 1, ON_TRACK: 1, COMPLETE: 2 });
    expect(statusCounts(rows, { ...NO_FILTERS, risk: "COMPLETE" })).toEqual({ ALL: 2, OPEN: 0, READY_FOR_REVIEW: 1, APPROVED: 1, REOPENED: 0 });
    expect(riskCounts(rows, { ...NO_FILTERS, status: "OPEN" })).toEqual({ ALL: 2, AT_RISK: 1, ON_TRACK: 1, COMPLETE: 0 });
  });
});
