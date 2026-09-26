import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryStores } from "../connector/index";
import { CLOCK, FIRM, REAL_NOW, contactFixture, memoryStores, seedDemoSlice } from "../connector/testing";
import type { Message } from "../domain/conversations";
import type { NewEntity } from "../domain/common";
import { createLogger } from "../lib/log";
import { createPolicyAuditHandler } from "../handlers/policy-audit";
import { POLICY_VIOLATIONS_METRIC, runPolicyAudit } from "./audit";
import { reevaluateSend } from "./reevaluate";

const GRANTED_AT = "2026-09-30T12:00:00-03:00";

const toImporter: NewEntity<typeof Message> = {
  messageId: "msg-01JAAAA",
  operationId: "op-4471",
  firmId: FIRM,
  clockId: CLOCK,
  direction: "OUT",
  channel: "WHATSAPP",
  kind: "DOCS_REQUEST",
  counterpart: "IMPORTER",
  importerId: "imp-norpampa",
  to: "+5491155500101",
  from: "simulated",
  body: "Operación 4471: faltan documentos.",
  status: "SENT",
  author: "AGENT",
  sentAtSim: "2026-10-15T10:00:00-03:00",
  sentAtReal: REAL_NOW,
  template: { name: "legajo_docs_pendientes", params: ["Estudio Delta", "4471"] },
};

const toSupplier: NewEntity<typeof Message> = {
  ...toImporter,
  messageId: "msg-01JBBBB",
  channel: "EMAIL",
  counterpart: "SUPPLIER",
  importerId: undefined,
  contactId: "ctc-qingdao-1",
  to: "supplier-qingdao@sim.legajo.demo.craftech.io",
  from: "op-4471-k7p2q9@legajo.demo.craftech.io",
  body: "Operation 4471: documents requested.",
  template: undefined,
  sentAtSim: "2026-10-15T11:00:00-03:00",
};

describe("[FL-060] policy audit", () => {
  let stores: MemoryStores;
  let lines: string[];

  const deps = () => ({ data: stores.connector, now: () => new Date(REAL_NOW), log: createLogger({ sink: (line) => void lines.push(line) }), correlationId: "policy-audit-test" });

  async function allow(message: NewEntity<typeof Message>): Promise<void> {
    await stores.connector.audit.record({
      firmId: FIRM,
      clockId: CLOCK,
      decision: "ALLOW",
      action: message.channel === "EMAIL" ? "SEND_EMAIL" : "SEND_WHATSAPP",
      ruleIds: ["CP-OPTIN"],
      evaluated: [{ ruleId: "CP-OPTIN", result: "PASS" }],
      messageId: message.messageId,
      actor: "AGENT",
      refs: { operationId: message.operationId, messageId: message.messageId },
      atSim: message.sentAtSim,
      atReal: REAL_NOW,
    });
  }

  async function send(message: NewEntity<typeof Message>, withAllow = true): Promise<void> {
    await stores.connector.conversations.appendMessage(message);
    if (withAllow) await allow(message);
  }

  beforeEach(async () => {
    lines = [];
    stores = memoryStores();
    await seedDemoSlice(stores);
    const { parties } = stores.connector;
    await parties.grantConsent({ importerId: "imp-norpampa", atSim: GRANTED_AT, by: "SEED", medium: "SIGNED_FORM", textVersion: "v1" });
    await parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true, atSim: GRANTED_AT, by: "SEED" });
  });

  it("[FL-060] finds nothing wrong in clean sends", async () => {
    await send(toImporter);
    await send(toSupplier);
    const report = await runPolicyAudit(deps(), { firmId: FIRM, clockId: CLOCK });
    expect(report).toMatchObject({ operations: 1, messagesChecked: 2, violations: [] });
    expect(await stores.connector.audit.listByDecision(FIRM, "VIOLATION")).toEqual([]);
  });

  it("[FL-060] flags a send that skipped the pipeline, once however often it runs", async () => {
    await send(toImporter, false);
    const first = await runPolicyAudit(deps(), { firmId: FIRM });
    expect(first.violations).toEqual([{ operationId: "op-4471", messageId: "msg-01JAAAA", check: "NO_ALLOW", ruleIds: [], recorded: true }]);
    const second = await runPolicyAudit(deps(), { firmId: FIRM });
    expect(second.violations).toMatchObject([{ check: "NO_ALLOW", recorded: false }]);
    const rows = await stores.connector.audit.listByDecision(FIRM, "VIOLATION");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "SEND_WITHOUT_ALLOW", messageId: "msg-01JAAAA", operationId: "op-4471", actor: "SYSTEM" });
    expect(lines.filter((line) => line.includes(POLICY_VIOLATIONS_METRIC))).toHaveLength(2);
  });

  it("[FL-060] does not flag a revocation or a bounce that came after the send", async () => {
    await send(toImporter);
    await send(toSupplier);
    const { parties } = stores.connector;
    await parties.revokeConsent({ importerId: "imp-norpampa", atSim: "2026-10-16T09:00:00-03:00", by: "IMPORTER" });
    await parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: false, atSim: "2026-10-16T09:00:00-03:00", by: "SEED" });
    await parties.transitionContact({ supplierId: "sup-qingdao", contactId: "ctc-qingdao-1", to: "BOUNCED", atSim: "2026-10-15T12:00:00-03:00", by: "SYSTEM", reason: "Permanent" });
    const report = await runPolicyAudit(deps(), { firmId: FIRM, clockId: CLOCK });
    expect(report.violations).toEqual([]);
  });

  it("[FL-060] flags a send the policy of that moment would have denied", async () => {
    await stores.connector.parties.revokeConsent({ importerId: "imp-norpampa", atSim: "2026-10-15T09:00:00-03:00", by: "IMPORTER" });
    await send(toImporter);
    const report = await runPolicyAudit(deps(), { firmId: FIRM });
    expect(report.violations).toMatchObject([{ check: "REEVALUATION", ruleIds: ["CP-OPTOUT"], recorded: true }]);
    const [row] = await stores.connector.audit.listByDecision(FIRM, "VIOLATION");
    expect(row).toMatchObject({ action: "POLICY_REEVALUATION_FAILED", ruleIds: ["CP-OPTOUT"], evaluated: [{ ruleId: "CP-OPTOUT", result: "DENY" }] });
  });

  it("[FL-060] skips inbound, queued and deferred messages and honours the look-back window", async () => {
    await stores.connector.conversations.appendMessage({ ...toImporter, messageId: "msg-01JCCCC", status: "DEFERRED" });
    await stores.connector.conversations.appendMessage({ ...toImporter, messageId: "msg-01JDDDD", direction: "IN", status: "RECEIVED", author: "IMPORTER" });
    await send({ ...toImporter, messageId: "msg-01JEEEE", sentAtReal: "2026-09-20T15:00:00.000Z" }, false);
    const report = await runPolicyAudit(deps(), { firmId: FIRM, sinceReal: "2026-09-25T00:00:00.000Z" });
    expect(report).toMatchObject({ messagesChecked: 0, violations: [] });
  });

  it("[FL-060] rebuilds each rule from the dated histories", async () => {
    const operation = await stores.connector.operations.getOperation("op-4471");
    const contact = await stores.connector.parties.createContact(contactFixture({ contactId: "ctc-qingdao-2", email: "supplier-qingdao-ops@sim.legajo.demo.craftech.io", emailHash: "a".repeat(64), status: "PENDING_CONFIRMATION", confirmedBy: undefined, confirmedAt: undefined }));
    const authorization = await stores.connector.parties.getAuthorization("imp-norpampa", "sup-qingdao");
    const facts = { operation, authorization, contact };
    expect(reevaluateSend({ ...facts, message: { ...toSupplier, kind: "DOCS_REQUEST" } }).map((breach) => breach.ruleId)).toEqual(["CP-SUPPLIER-AUTH"]);
    const approved = { ...operation, dossierHistory: [...operation.dossierHistory, { status: "APPROVED" as const, atSim: "2026-10-15T08:00:00-03:00", by: "BROKER:brk-delta-diego" as const }] };
    expect(reevaluateSend({ operation: approved, consent: undefined, message: { ...toImporter, kind: "APPROVAL_NOTICE" } }).map((breach) => breach.ruleId)).toEqual(["CP-OPTIN"]);
    expect(reevaluateSend({ operation: approved, message: { ...toImporter, kind: "REMINDER", channel: "CONSOLE" } }).map((breach) => breach.ruleId)).toEqual(["CP-APPROVED-SCOPE"]);
    const takenOver = { ...operation, controlHistory: [...operation.controlHistory, { control: "BROKER" as const, atSim: "2026-10-15T09:00:00-03:00", by: "BROKER:brk-delta-martina" as const }] };
    expect(reevaluateSend({ operation: takenOver, message: { ...toImporter, channel: "CONSOLE" } }).map((breach) => breach.ruleId)).toEqual(["CP-CONTROL-BROKER"]);
    expect(reevaluateSend({ operation: takenOver, message: { ...toImporter, channel: "CONSOLE", author: "BROKER:brk-delta-martina" } })).toEqual([]);
  });

  it("[FL-060] runs daily over the named firms and on demand only over a QA world", async () => {
    await send(toImporter, false);
    const handler = createPolicyAuditHandler(deps());
    const daily = await handler({ kind: "DAILY", firmIds: [FIRM, "firm-norte"] });
    expect(daily).toMatchObject({ violations: 1, reports: [{ firmId: FIRM, messagesChecked: 1 }, { firmId: "firm-norte", messagesChecked: 0 }] });
    await expect(handler({ kind: "WORLD", firmId: FIRM, clockId: CLOCK })).rejects.toThrow(/QA firms/);
    await expect(handler({ kind: "DAILY", firmIds: [FIRM], extra: true })).rejects.toThrow();
    expect(await handler({ kind: "WORLD", firmId: "firm-qa", clockId: "qa-812-sc20" })).toMatchObject({ violations: 0, reports: [{ firmId: "firm-qa", clockId: "qa-812-sc20", operations: 0 }] });
  });
});
