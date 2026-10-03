import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryStores } from "../connector/index";
import { CLOCK, FIRM, REAL_NOW, contactFixture, memoryStores, seedDemoSlice } from "../connector/testing";
import type { Message } from "../domain/conversations";
import type { NewEntity } from "../domain/common";
import { createLogger } from "../lib/log";
import { createPolicyAuditHandler } from "../handlers/policy-audit";
import { POLICY_AUDIT_FAILED_LOG, POLICY_VIOLATIONS_METRIC, POLICY_VIOLATION_LOG, runPolicyAudit } from "./audit";
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
  // 11:00 in Qingdao (Asia/Shanghai), inside the supplier's business hours.
  sentAtSim: "2026-10-15T00:00:00-03:00",
};

describe("[FL-060] policy audit", () => {
  let stores: MemoryStores;
  let lines: string[];

  const deps = () => ({ data: stores.connector, now: () => new Date(REAL_NOW), log: createLogger({ sink: (line) => void lines.push(line) }), correlationId: "policy-audit-test" });

  async function allow(message: NewEntity<typeof Message>, trigger?: string): Promise<void> {
    await stores.connector.audit.record({
      ...(trigger === undefined ? {} : { trigger }),
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

  async function send(message: NewEntity<typeof Message>, withAllow = true, trigger?: string): Promise<void> {
    await stores.connector.conversations.appendMessage(message);
    if (withAllow) await allow(message, trigger);
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
    await stores.connector.conversations.appendMessage({ ...toImporter, messageId: "msg-01JFFFF", status: "QUEUED" });
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
    expect(reevaluateSend({ operation: approved, message: { ...toImporter, kind: "REMINDER", channel: "CONSOLE" } }).map((breach) => breach.ruleId)).toEqual(["CP-KIND-CHANNEL", "CP-APPROVED-SCOPE"]);
    const takenOver = { ...operation, controlHistory: [...operation.controlHistory, { control: "BROKER" as const, atSim: "2026-10-15T09:00:00-03:00", by: "BROKER:brk-delta-martina" as const }] };
    expect(reevaluateSend({ operation: takenOver, message: { ...toImporter, kind: undefined, channel: "CONSOLE" } }).map((breach) => breach.ruleId)).toEqual(["CP-CONTROL-BROKER"]);
    expect(reevaluateSend({ operation: takenOver, message: { ...toImporter, kind: undefined, channel: "CONSOLE", author: "BROKER:brk-delta-martina" } })).toEqual([]);
    expect(reevaluateSend({ operation, message: { ...toSupplier, kind: "APPROVAL_NOTICE" }, authorization, contact }).map((breach) => breach.ruleId)).toEqual(["CP-KIND-CHANNEL", "CP-SUPPLIER-AUTH"]);
  });

  async function firm(firmId: string, kind: "DEMO" | "GUEST" | "QA"): Promise<void> {
    await stores.client.put("Firms", {
      PK: `FIRM#${firmId}`,
      SK: "META",
      entity: "Firm",
      createdAt: REAL_NOW,
      updatedAt: REAL_NOW,
      version: 1,
      firmId,
      name: `Estudio ${firmId}`,
      kind,
      ...(kind === "GUEST" ? { guestKind: "PUBLIC" } : {}),
      mailboxAddress: `estudio-${firmId}@sim.legajo.demo.craftech.io`,
      businessHours: { timezone: "America/Argentina/Buenos_Aires", from: "09:00", to: "18:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"] },
      active: true,
    });
  }

  it("[FL-060] runs daily over every DEMO and GUEST firm listed at run time, and on demand only over a QA world", async () => {
    await send(toImporter, false);
    await firm(FIRM, "DEMO");
    await firm("firm-guest-31", "GUEST");
    await firm("firm-qa", "QA");
    const handler = createPolicyAuditHandler(deps());
    const daily = await handler({ kind: "DAILY" });
    expect(daily).toMatchObject({ violations: 1, reports: [{ firmId: FIRM, messagesChecked: 1 }, { firmId: "firm-guest-31", messagesChecked: 0 }] });
    expect(daily.reports).toHaveLength(2);
    await expect(handler({ kind: "WORLD", firmId: FIRM, clockId: CLOCK })).rejects.toThrow(/QA firms/);
    await expect(handler({ kind: "DAILY", firmIds: [FIRM] })).rejects.toThrow();
    expect(await handler({ kind: "WORLD", firmId: "firm-qa", clockId: "qa-812-sc20" })).toMatchObject({ violations: 0, reports: [{ firmId: "firm-qa", clockId: "qa-812-sc20", operations: 0 }] });
  });

  it("[FL-060] flags a proactive WhatsApp sent out of Buenos Aires hours, not a reply to the importer", async () => {
    await send({ ...toImporter, sentAtSim: "2026-10-15T22:10:00-03:00" });
    const inbound = { ...toImporter, messageId: "msg-01JFFFF", direction: "IN" as const, status: "RECEIVED" as const, author: "IMPORTER" as const, kind: undefined, template: undefined, sentAtSim: "2026-10-16T22:05:00-03:00" };
    await stores.connector.conversations.appendMessage(inbound);
    await send({ ...toImporter, messageId: "msg-01JGGGG", kind: "REPLY", template: undefined, sentAtSim: "2026-10-16T22:06:00-03:00" }, true, "IMPORTER_MESSAGE");
    const report = await runPolicyAudit(deps(), { firmId: FIRM, clockId: CLOCK });
    expect(report.violations).toEqual([{ operationId: "op-4471", messageId: "msg-01JAAAA", check: "REEVALUATION", ruleIds: ["CP-HOURS-AR"], recorded: true }]);
  });

  it("[FL-060] flags a second request or reminder to the same contact on one simulated day", async () => {
    await send({ ...toImporter, kind: "REMINDER", template: { name: "legajo_recordatorio", params: ["4471"] } });
    await send({ ...toImporter, messageId: "msg-01JHHHH", kind: "REMINDER", template: { name: "legajo_recordatorio", params: ["4471"] }, sentAtSim: "2026-10-15T16:00:00-03:00" });
    await send({ ...toImporter, messageId: "msg-01JIIII", kind: "REMINDER", template: { name: "legajo_recordatorio", params: ["4471"] }, sentAtSim: "2026-10-16T10:00:00-03:00" });
    const report = await runPolicyAudit(deps(), { firmId: FIRM });
    expect(report.violations).toEqual([expect.objectContaining({ messageId: "msg-01JHHHH", check: "REEVALUATION", ruleIds: ["CP-ONE-PER-DAY"] })]);
  });

  it("[FL-060] flags free text outside the 24-hour window and an email out of the supplier's hours", async () => {
    await send({ ...toImporter, kind: "UPLOAD_LINK", template: undefined, simulated: true });
    await send({ ...toSupplier, sentAtSim: "2026-10-15T11:00:00-03:00" });
    const report = await runPolicyAudit(deps(), { firmId: FIRM });
    expect(report.violations.map((violation) => [violation.messageId, violation.ruleIds])).toEqual([
      ["msg-01JAAAA", ["CP-WA-24H"]],
      ["msg-01JBBBB", ["CP-HOURS-SUPPLIER"]],
    ]);
  });

  it("[FL-060] counts a violation before writing it, and a failed write never ends the run", async () => {
    await send(toImporter, false);
    await send(toSupplier, false);
    const { audit } = stores.connector;
    let calls = 0;
    const flaky = { ...audit, recordOnce: async (...args: Parameters<typeof audit.recordOnce>) => ((calls += 1) === 1 ? Promise.reject(new Error("AccessDenied")) : audit.recordOnce(...args)) };
    const report = await runPolicyAudit({ ...deps(), data: { ...stores.connector, audit: flaky } }, { firmId: FIRM });
    expect(report).toMatchObject({ messagesChecked: 2, failed: 1, violations: [{ messageId: "msg-01JAAAA", check: "NO_ALLOW", recorded: true }] });
    expect(lines.filter((line) => line.includes(POLICY_VIOLATION_LOG))).toHaveLength(2);
    expect(lines.filter((line) => line.includes(POLICY_AUDIT_FAILED_LOG))).toHaveLength(1);
  });

  it("[FL-060] a firm that cannot be read never leaves the other firms of the daily run unaudited", async () => {
    await send(toImporter, false);
    const { operations } = stores.connector;
    const broken = { ...operations, listOperations: async (firmId: string, options?: Parameters<typeof operations.listOperations>[1]) => (firmId === "firm-norte" ? Promise.reject(new Error("AccessDenied")) : operations.listOperations(firmId, options)) };
    await firm(FIRM, "DEMO");
    await firm("firm-norte", "DEMO");
    const handler = createPolicyAuditHandler({ ...deps(), data: { ...stores.connector, operations: broken } });
    expect(await handler({ kind: "DAILY" })).toMatchObject({ failedFirms: ["firm-norte"], violations: 1, reports: [{ firmId: FIRM }] });
  });
});
