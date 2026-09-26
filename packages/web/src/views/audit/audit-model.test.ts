import { describe, expect, it } from "vitest";
import {
  type AuditRow,
  actionLabel,
  actorKindOf,
  actorLabel,
  actorOptions,
  decisionInput,
  filterDecisions,
  operationNumberOfDecision,
  ruleCountRows,
  ruleOptionLabel,
  ruleOptions,
  totals,
  triggerLabel,
} from "./audit-model";

function decision(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    decisionId: "01JD0000000000000000000001",
    ts: "2026-10-15T13:00:00.000Z",
    decision: "DEFER",
    action: "SEND_EMAIL",
    ruleIds: ["CP-HOURS-SUPPLIER"],
    evaluated: [],
    actor: "AGENT",
    refs: {},
    operationId: "op-4471",
    trigger: "IMPORTER_MESSAGE",
    atSim: "2026-10-15T10:05:00-03:00",
    atReal: "2026-09-26T15:00:00.000Z",
    ...overrides,
  } as AuditRow;
}

const ROWS: AuditRow[] = [
  decision(),
  decision({ decisionId: "d2", decision: "DENY", ruleIds: ["CP-OPTIN"], actor: "AGENT", operationId: "op-4473" }),
  decision({ decisionId: "d3", decision: "ACTION", action: "CONSENT_GRANTED", ruleIds: [], actor: "BROKER:brk-delta-martina", trigger: undefined }),
  decision({ decisionId: "d4", decision: "ALLOW", action: "SEND_WHATSAPP", ruleIds: ["CP-OPTIN", "CP-WA-24H"], actor: "SYSTEM" }),
];

describe("the words of the audit log", () => {
  it("names each stored code for the firm and never shows an unknown one raw", () => {
    expect(actionLabel("CONSENT_GRANTED")).toBe("Opt-in registrado");
    expect(actionLabel("SOME_NEW_THING")).toBe("some new thing");
    expect(triggerLabel("ETA_CHANGED")).toBe("Cambio de ETA");
    expect(triggerLabel(undefined)).toBeUndefined();
    expect(ruleOptionLabel("CP-HOURS-SUPPLIER")).toBe("Horario del proveedor · CP-HOURS-SUPPLIER");
  });

  it("groups actors: a broker id reads as a person of the firm, never as its id", () => {
    expect(actorKindOf("BROKER:brk-delta-diego")).toBe("FIRM");
    expect(actorLabel("BROKER:brk-delta-diego")).toBe("Persona del estudio");
    expect(actorLabel("AGENT")).toBe("Agente");
    expect(actorKindOf("SOMETHING")).toBe("SYSTEM");
  });

  it("reads the operation number of a decision about one operation", () => {
    expect(operationNumberOfDecision(decision())).toBe("4471");
    expect(operationNumberOfDecision(decision({ operationId: undefined }))).toBeUndefined();
  });
});

describe("filters of the bitácora", () => {
  it("filters by rule and by actor over what the list brought", () => {
    expect(filterDecisions(ROWS, { ruleId: "CP-OPTIN" }).map((row) => row.decisionId)).toEqual(["d2", "d4"]);
    expect(filterDecisions(ROWS, { actor: "FIRM" }).map((row) => row.decisionId)).toEqual(["d3"]);
    expect(filterDecisions(ROWS, { ruleId: "CP-OPTIN", actor: "SYSTEM" }).map((row) => row.decisionId)).toEqual(["d4"]);
    expect(filterDecisions(ROWS, {})).toHaveLength(4);
  });

  it("offers only the rules and actors present, and sends the decision filter to audit.list", () => {
    expect(ruleOptions(ROWS)).toEqual(["CP-HOURS-SUPPLIER", "CP-OPTIN", "CP-WA-24H"]);
    expect(actorOptions(ROWS)).toEqual(["AGENT", "SYSTEM", "FIRM"]);
    expect(decisionInput("ALL")).toEqual({});
    expect(decisionInput("DENY")).toEqual({ decision: "DENY" });
  });
});

describe("DENY and DEFER by rule, next to the violations counter", () => {
  it("orders the rules that stopped the agent most first and adds them up", () => {
    const rows = ruleCountRows({ "CP-OPTIN": { deny: 1, defer: 0 }, "CP-HOURS-SUPPLIER": { deny: 0, defer: 3 }, "CP-HOURS-AR": { deny: 0, defer: 1 } });
    expect(rows.map((row) => row.ruleId)).toEqual(["CP-HOURS-SUPPLIER", "CP-HOURS-AR", "CP-OPTIN"]);
    expect(totals(rows)).toEqual({ deny: 1, defer: 4 });
    expect(totals([])).toEqual({ deny: 0, defer: 0 });
  });
});
