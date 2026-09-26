import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStores, type MemoryStores } from "./index";
import { CLOCK, FIRM, REAL_NOW, memoryStores, seedDemoSlice } from "../testing";

const NOW_EPOCH = Date.parse(REAL_NOW) / 1000;

describe("memory connector: conversations and audit", () => {
  let stores: MemoryStores;
  const outbound = {
    messageId: "msg-01JAAAA",
    operationId: "op-4471",
    firmId: FIRM,
    clockId: CLOCK,
    direction: "OUT" as const,
    channel: "WHATSAPP" as const,
    kind: "DOCS_REQUEST" as const,
    counterpart: "IMPORTER" as const,
    importerId: "imp-norpampa",
    to: "+5491155500101",
    from: "simulated",
    body: "Operación 4471, buque Austral Aurora.",
    status: "SENT" as const,
    author: "AGENT" as const,
    sentAtSim: "2026-10-15T10:00:00-03:00",
    sentAtReal: REAL_NOW,
    template: { name: "legajo_docs_pendientes" as const, params: ["Estudio Delta", "4471"] },
  };

  beforeEach(async () => {
    stores = memoryStores();
    await seedDemoSlice(stores);
  });

  it("appends messages once, in simulated order, with the counterpart's contact window and a 90-day TTL", async () => {
    const { conversations } = stores.connector;
    const sent = await conversations.appendMessage(outbound);
    expect(sent).toMatchObject({ sentAtSim: "2026-10-15T13:00:00.000Z", expiresAt: NOW_EPOCH + 90 * 24 * 3600, trusted: false, buttons: [] });
    expect(await stores.client.get("Conversations", { PK: "OP#op-4471", SK: "MSG#2026-10-15T13:00:00.000Z#msg-01JAAAA" })).toMatchObject({ counterpartKey: "IMP#imp-norpampa" });
    await expect(conversations.appendMessage(outbound)).rejects.toMatchObject({ code: "CONFLICT" });
    await conversations.appendMessage({ ...outbound, messageId: "msg-01JAAAB", direction: "IN", status: "RECEIVED", author: "IMPORTER", trusted: true, sentAtSim: "2026-10-15T10:05:00-03:00", body: "Los manda el proveedor" });
    expect((await conversations.listMessages("op-4471")).map((message) => message.messageId)).toEqual(["msg-01JAAAA", "msg-01JAAAB"]);
    const day = await conversations.listCounterpartMessages("IMP#imp-norpampa", { fromSim: "2026-10-15T00:00:00-03:00", toSim: "2026-10-15T10:05:00-03:00" });
    expect(day.map((message) => message.messageId)).toEqual(["msg-01JAAAA"]);
    expect(await conversations.listCounterpartMessages("IMP#imp-norpampa", { direction: "IN" })).toHaveLength(1);
  });

  it("finds a message by its provider id once the provider accepted it, and records delivery events once", async () => {
    const { conversations } = stores.connector;
    const sent = await conversations.appendMessage({ ...outbound, status: "QUEUED" });
    expect(await conversations.findMessageByProviderId("wamid.SIM.1")).toBeUndefined();
    const ref = { operationId: "op-4471", messageId: sent.messageId, sentAtSim: sent.sentAtSim };
    await conversations.updateMessage(ref, { status: "SENT", providerMessageId: "wamid.SIM.1" }, 1);
    expect((await conversations.findMessageByProviderId("wamid.SIM.1"))?.messageId).toBe("msg-01JAAAA");
    await expect(conversations.updateMessage(ref, { status: "DELIVERED" }, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    const event = { eventId: "evt-d-1", operationId: "op-4471", clockId: CLOCK, messageId: sent.messageId, type: "DELIVERED" as const, atReal: REAL_NOW, simulated: true };
    expect((await conversations.recordMessageEvent(event)).created).toBe(true);
    expect((await conversations.recordMessageEvent(event)).created).toBe(false);
    expect(await conversations.listMessageEvents("op-4471")).toHaveLength(1);
    expect((await conversations.getMessage("op-4471", "msg-01JAAAA"))?.status).toBe("SENT");
    expect(await conversations.getMessage("op-4471", "msg-01JZZZZ")).toBeUndefined();
  });

  it("keeps turn notes and the firm's mailbox, newest mail first", async () => {
    const { conversations } = stores.connector;
    await conversations.appendTurnNote({ turnId: "turn-1", operationId: "op-4471", clockId: CLOCK, trigger: "MILESTONE", text: "Pedido inicial enviado.", atSim: "2026-10-15T10:00:00-03:00", atReal: REAL_NOW });
    expect(await conversations.listTurnNotes("op-4471")).toHaveLength(1);
    const mailbox = "estudio-delta@sim.legajo.demo.craftech.io";
    const mail = { mailboxAddress: mailbox, firmId: FIRM, operationId: "op-4471", from: "avisos@legajo.demo.craftech.io", to: mailbox, subject: "[Op 4478] Escalation", bodyText: "Estado del legajo", references: [] };
    await conversations.putMailboxMessage({ ...mail, mailboxMessageId: "m1", receivedAtReal: "2026-09-26T15:00:00.000Z" });
    await conversations.putMailboxMessage({ ...mail, mailboxMessageId: "m2", receivedAtReal: "2026-09-26T15:05:00.000Z" });
    expect((await conversations.listMailbox(mailbox)).map((message) => message.mailboxMessageId)).toEqual(["m2", "m1"]);
    expect(await conversations.listMailbox(mailbox, { limit: 1 })).toHaveLength(1);
  });

  it("appends decisions by firm and month of their simulated instant, findable by operation, kind and message", async () => {
    const { audit } = stores.connector;
    const allow = await audit.record({
      firmId: FIRM,
      decision: "ALLOW",
      action: "SEND_WHATSAPP",
      ruleIds: ["CP-OPTIN", "CP-HOURS-AR"],
      evaluated: [{ ruleId: "CP-OPTIN", result: "PASS" }],
      messageId: "msg-01JAAAA",
      actor: "AGENT",
      clockId: CLOCK,
      operationId: "op-4471",
      atSim: "2026-10-15T10:00:00-03:00",
      atReal: REAL_NOW,
    });
    expect(allow).toMatchObject({ month: "2026-10", ts: "2026-10-15T13:00:00.000Z", decisionId: "ID0000000001", expiresAt: NOW_EPOCH + 365 * 24 * 3600 });
    await audit.record({ firmId: FIRM, decision: "DENY", action: "SEND_WHATSAPP", ruleIds: ["CP-OPTIN"], actor: "AGENT", refs: { operationId: "op-4471" }, atSim: "2026-10-15T11:00:00-03:00", atReal: REAL_NOW });
    expect((await audit.listByOperation("op-4471")).map((decision) => decision.decision)).toEqual(["ALLOW", "DENY"]);
    expect(await audit.listByOperation("op-4471", { from: "2026-10-15T10:30:00-03:00" })).toHaveLength(1);
    expect(await audit.listByDecision(FIRM, "DENY")).toHaveLength(1);
    expect(await audit.listByMonth(FIRM, "2026-10")).toHaveLength(2);
    expect((await audit.findAllowForMessage("op-4471", "msg-01JAAAA"))?.decisionId).toBe(allow.decisionId);
    expect(await audit.findAllowForMessage("op-4471", "msg-01JZZZZ")).toBeUndefined();
    await expect(audit.record({ firmId: FIRM, decision: "ACTION", action: "not upper", actor: "SYSTEM", atReal: REAL_NOW })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("records a decision once per key, whatever the real instant of the repeat", async () => {
    const { audit } = stores.connector;
    const violation = { firmId: FIRM, decision: "VIOLATION" as const, action: "SEND_WITHOUT_ALLOW", actor: "SYSTEM" as const, messageId: "msg-01JAAAA", atSim: "2026-10-15T10:00:00-03:00", atReal: REAL_NOW };
    expect(await audit.recordOnce("msg-01JAAAA#NO_ALLOW", violation)).toEqual({ recorded: true });
    expect(await audit.recordOnce("msg-01JAAAA#NO_ALLOW", { ...violation, atReal: "2026-09-27T15:00:00.000Z" })).toEqual({ recorded: false });
    expect(await audit.recordOnce("msg-01JAAAA#REEVALUATION", violation)).toEqual({ recorded: true });
    expect(await audit.listByDecision(FIRM, "VIOLATION")).toHaveLength(2);
  });
});

describe("memory connector: runtime, world state and metrics", () => {
  let stores: MemoryStores;

  beforeEach(() => {
    stores = memoryStores();
  });

  it("opens a turn, numbers its results per turn, and refuses results after it closed", async () => {
    const { runtime } = stores.connector;
    await runtime.putSession({ sessionId: "s1", turnId: "t1", operationId: "op-4471", firmId: FIRM, importerId: "imp-norpampa", supplierId: "sup-qingdao", trigger: "MILESTONE", clockId: CLOCK, eventAtSim: "2026-10-15T10:00:00-03:00", worldEpoch: 1, sessionEpoch: 0 });
    expect((await runtime.getSession("s1"))?.expiresAt).toBe(NOW_EPOCH + 3600);
    await runtime.openTurn({ turnId: "t1", sessionId: "s1", operationId: "op-4471", clockId: CLOCK, trigger: "MILESTONE", openedAtReal: REAL_NOW });
    await runtime.appendTurnResult({ turnId: "t1", tool: "get_dossier", output: { complete: false }, atReal: REAL_NOW });
    await runtime.appendTurnResult({ turnId: "t1", tool: "get_operation", output: { operationNumber: "4471" }, atReal: REAL_NOW });
    expect((await runtime.listTurnResults("t1")).map((result) => [result.tool, result.seq])).toEqual([["get_dossier", 1], ["get_operation", 2]]);
    const closed = await runtime.closeTurn("t1", "2026-09-26T15:01:00.000Z");
    expect((await runtime.closeTurn("t1", "2026-09-26T15:09:00.000Z")).closedAtReal).toBe(closed.closedAtReal);
    await expect(runtime.appendTurnResult({ turnId: "t1", tool: "get_dossier", output: {}, atReal: REAL_NOW })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("uses a nonce once, caps pre-signs per link and deduplicates by idempotency key", async () => {
    const { runtime } = stores.connector;
    await runtime.putNonce({ nonce: "01JNONCE0001", action: "SUPPLIER_SENDS", operationId: "op-4471", importerId: "imp-norpampa", phoneHash: "a".repeat(64), clockId: CLOCK, payload: {} });
    await runtime.useNonce("01JNONCE0001", REAL_NOW);
    await expect(runtime.useNonce("01JNONCE0001", REAL_NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    const token = "t".repeat(43);
    await runtime.putUploadLink({ token, operationId: "op-4471", importerId: "imp-norpampa", firmId: FIRM, clockId: CLOCK, docTypes: ["PACKING_LIST"], createdAtReal: REAL_NOW, expiresAtReal: "2026-09-29T15:00:00.000Z" });
    for (let index = 0; index < 20; index += 1) await runtime.recordPresign(token, REAL_NOW);
    await expect(runtime.recordPresign(token, REAL_NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await runtime.getUploadLink(token))?.presignCount).toBe(20);
    expect(await runtime.claimIdempotency({ source: "EMAIL", id: "ses-1", atReal: REAL_NOW })).toBe(true);
    expect(await runtime.claimIdempotency({ source: "EMAIL", id: "ses-1", atReal: REAL_NOW })).toBe(false);
  });

  it("counts per sender and simulated hour, per firm and real hour, and named counters", async () => {
    const { runtime } = stores.connector;
    const rate = { clockId: "qa-812-sc18-rate", addressHash: "b".repeat(64), simHour: "2026-10-15T13" };
    expect(await runtime.incrementRate(rate)).toBe(1);
    expect(await runtime.incrementRate(rate)).toBe(2);
    expect(await stores.client.get("Runtime", { PK: `RATE#qa-812-sc18-rate#${"b".repeat(64)}#2026-10-15T13`, SK: "META" })).toMatchObject({ world: "qa", expiresAt: NOW_EPOCH + 48 * 3600 });
    expect(await runtime.incrementTurnCap({ firmId: FIRM, window: "H2026-09-26T15" })).toBe(1);
    expect(await runtime.incrementCounter("probe", 3)).toBe(3);
  });

  it("raises the epoch from a counter that never goes back, and tombstones past epochs", async () => {
    const { world } = stores.connector;
    expect(await world.currentEpoch(CLOCK)).toBeUndefined();
    expect(await world.nextEpoch(CLOCK)).toBe(1);
    expect(await world.nextEpoch(CLOCK)).toBe(2);
    expect((await stores.client.get("Runtime", { PK: `COUNTER#EPOCH#${CLOCK}`, SK: "META" }))?.expiresAt).toBeUndefined();
    await world.nextEpoch("qa-812-sc20");
    expect((await stores.client.get("Runtime", { PK: "COUNTER#EPOCH#qa-812-sc20", SK: "META" }))?.expiresAt).toBe(NOW_EPOCH + 48 * 3600);
    await world.putTombstone({ clockId: CLOCK, worldEpoch: 1, atReal: REAL_NOW });
    await world.putTombstone({ clockId: CLOCK, worldEpoch: 1, atReal: "2026-09-26T16:00:00.000Z" });
    expect(await world.isTombstoned(CLOCK, 1)).toBe(true);
    expect(await world.isTombstoned(CLOCK, 2)).toBe(false);
  });

  it("keeps the clock of a world and moves it pinned to its version", async () => {
    const { world } = stores.connector;
    await world.createClock({ clockId: CLOCK, firmId: FIRM, mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-14T10:30:00-03:00", startAtSim: "2026-10-14T10:30:00-03:00", worldEpoch: 1, settings: { rateLimitPerHour: 20 } });
    await expect(world.createClock({ clockId: CLOCK, firmId: FIRM, mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-14T10:30:00-03:00", startAtSim: "2026-10-14T10:30:00-03:00", worldEpoch: 1, settings: { rateLimitPerHour: 20 } })).rejects.toMatchObject({ code: "CONFLICT" });
    const running = await world.updateClock(CLOCK, { mode: "RUNNING", offsetMs: 1_000, runningUntilReal: "2026-09-26T15:30:00.000Z" }, 1);
    await expect(world.updateClock(CLOCK, { pausedSimNow: "2026-10-15T10:00:00-03:00" }, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    const paused = await world.updateClock(CLOCK, { mode: "PAUSED", runningUntilReal: null }, running.version);
    expect(paused.runningUntilReal).toBeUndefined();
    await expect(world.updateClock(CLOCK, { mode: "STOPPED" as never })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(world.updateClock(CLOCK, { mode: null as never })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await world.getClock(CLOCK)).mode).toBe("PAUSED");
  });

  it("tracks in-flight events per operation and per world, and a dead-lettered one leaves both sets", async () => {
    const { world } = stores.connector;
    const event = { operationId: "op-7001", clockId: "qa-812-sc98", eventId: "evt-1" };
    await world.markInFlight(event);
    await world.markInFlight(event);
    await world.markInFlight({ ...event, eventId: "evt-2" });
    expect((await world.getOpState("op-7001"))?.inFlight).toEqual(["evt-1", "evt-2"]);
    expect((await world.getWorldState("qa-812-sc98"))?.inFlight).toEqual(["op-7001#evt-1", "op-7001#evt-2"]);
    await world.settleInFlight(event);
    await world.recordProcessError({ ...event, eventId: "evt-2", type: "POISON", atReal: REAL_NOW });
    const state = await world.getOpState("op-7001");
    expect(state).toMatchObject({ inFlight: [], processError: { eventId: "evt-2", type: "POISON" }, world: "qa" });
    expect((await world.getWorldState("qa-812-sc98"))?.inFlight).toEqual([]);
    await world.clearProcessError("op-7001");
    expect((await world.getOpState("op-7001"))?.processError).toBeUndefined();
    await world.clearProcessError("op-none");
  });

  it("closes a pending mail only for its own sender and reports pending mails and scans of a world", async () => {
    const { world } = stores.connector;
    const pending = { clockId: CLOCK, mailId: "01JMAIL00001", operationId: "op-4471", from: "op-4471-k7p2q9@legajo.demo.craftech.io", to: "supplier-qingdao@sim.legajo.demo.craftech.io", profile: "SYSTEM" as const, awaiting: "SIMMAIL" as const, sentAtReal: REAL_NOW };
    const written = await world.putMailPending(pending);
    expect(written).toMatchObject({ staleAtReal: "2026-09-26T15:10:00.000Z", expiresAt: NOW_EPOCH + 48 * 3600 });
    await world.putScanPending({ clockId: CLOCK, scanKey: "0a1b2c3d", bucket: "Media", objectKey: "sim/msg-1/1.pdf", createdAtReal: REAL_NOW });
    expect(await world.listPending(CLOCK)).toMatchObject({ mails: [{ mailId: "01JMAIL00001" }], scans: [{ scanKey: "0a1b2c3d" }] });
    expect(await world.closeMailPending({ clockId: CLOCK, mailId: "01JMAIL00001", from: "someone@sim.legajo.demo.craftech.io" })).toBe(false);
    expect(await world.closeMailPending({ clockId: CLOCK, mailId: "01JMAIL00001", from: pending.from })).toBe(true);
    expect(await world.closeMailPending({ clockId: CLOCK, mailId: "01JMAIL00001", from: pending.from })).toBe(false);
    expect(await world.closeScanPending(CLOCK, "0a1b2c3d")).toBe(true);
    expect(await world.listPending(CLOCK)).toEqual({ mails: [], scans: [] });
  });

  it("skips a live lease and takes over a lapsed one", async () => {
    const later = createMemoryStores({ now: () => new Date("2026-09-28T16:00:00.000Z") });
    const { world } = stores.connector;
    expect(await world.acquireLease({ kind: "OPNUM", value: "7001", holder: "qa-812-sc01", atReal: REAL_NOW })).toBe(true);
    expect(await world.acquireLease({ kind: "OPNUM", value: "7001", holder: "qa-812-sc02", atReal: REAL_NOW })).toBe(false);
    expect(await world.releaseLease({ kind: "OPNUM", value: "7001", holder: "qa-812-sc02" })).toBe(false);
    // Same table, 49 hours later: the lease lapsed (TTL deletion is lazy) and can be taken over.
    for (const row of stores.client.dump("Runtime")) await later.client.put("Runtime", row);
    expect(await later.connector.world.acquireLease({ kind: "OPNUM", value: "7001", holder: "qa-900-sc02", atReal: "2026-09-28T16:00:00.000Z" })).toBe(true);
    expect((await later.connector.world.getLease("OPNUM", "7001"))?.holder).toBe("qa-900-sc02");
    expect(await world.releaseLease({ kind: "OPNUM", value: "7001", holder: "qa-812-sc01" })).toBe(true);
  });

  it("adds to a dossier's KPIs atomically, creating the row on first use", async () => {
    const { metrics } = stores.connector;
    const ref = { firmId: FIRM, source: "WORLD" as const, clockId: CLOCK, operationId: "op-4471" };
    await metrics.incrementKpi(ref, { turns: 1, inputTokens: 1200, outputTokens: 300 }, { agentMode: "REAL" });
    const kpi = await metrics.incrementKpi(ref, { turns: 1, whatsappSent: 1, humanMinutes: 2.5 }, { agentMode: "REAL" });
    expect(kpi).toMatchObject({ turns: 2, inputTokens: 1200, whatsappSent: 1, humanMinutes: 2.5, emailSent: 0, agentMode: "REAL", version: 2 });
    expect((await metrics.updateKpi(ref, { dossierStatus: "APPROVED", completedAtSim: "2026-10-18T11:00:00-03:00" })).dossierStatus).toBe("APPROVED");
    expect(await metrics.listKpis(FIRM, { source: "WORLD", clockId: CLOCK })).toHaveLength(1);
    expect(await metrics.listKpis(FIRM, { source: "BATCH" })).toEqual([]);
    await expect(metrics.incrementKpi(ref, { turns: -1 }, { agentMode: "REAL" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("appends latency samples to the KPI row, creating it on first use", async () => {
    const { metrics } = stores.connector;
    const ref = { firmId: FIRM, source: "WORLD" as const, clockId: CLOCK, operationId: "op-4472" };
    expect((await metrics.recordFirstResponse(ref, 12_400, { agentMode: "REAL" })).firstResponseMs).toEqual([12_400]);
    expect(await metrics.recordFirstResponse(ref, 8_100, { agentMode: "REAL" })).toMatchObject({ firstResponseMs: [12_400, 8_100], turns: 0 });
    await expect(metrics.recordFirstResponse(ref, -1, { agentMode: "REAL" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

