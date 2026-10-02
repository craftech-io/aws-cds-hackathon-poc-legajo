import { describe, expect, it } from "vitest";
import { DISPATCH_GLOSSARY } from "../copy/dispatch-glossary";
import { createLogger } from "../lib/log";
import { sendOutbound } from "../outbound/pipeline";
import { REAL_NOW, outboundWorld, type OutboundWorld } from "../outbound/testing";
import { fakeScheduler } from "../sim-mail/testing";
import type { DispatchStatusEvent } from "../worker/events";
import type { WorkerContext } from "../worker/ports";
import { type DispatchDeps, dispatchMessageId, notifyDispatchStatus } from "./dispatch";
import { CUSTOMS_EVENT_ID } from "./testing";

const OPERATION = "op-4471";

function dispatchEvent(overrides: Partial<DispatchStatusEvent> = {}): DispatchStatusEvent {
  return {
    type: "DISPATCH_STATUS",
    eventId: CUSTOMS_EVENT_ID,
    operationId: OPERATION,
    clockId: "GLOBAL#firm-delta",
    firmId: "firm-delta",
    eventAtSim: "2026-10-21T11:00:00-03:00",
    occurredAtSim: "2026-10-21T11:00:00-03:00",
    status: "OFICIALIZADO",
    ...overrides,
  };
}

async function setup(options: { readonly approved?: boolean } = {}) {
  const world = await outboundWorld();
  const { operations } = world.stores.connector;
  if (options.approved !== false) {
    await operations.transitionDossier({ operationId: OPERATION, to: "READY_FOR_REVIEW", atSim: "2026-10-20T10:00:00-03:00", by: "AGENT" });
    await operations.transitionDossier({ operationId: OPERATION, to: "APPROVED", approvedBy: "brk-ana-sosa", atSim: "2026-10-20T11:00:00-03:00", by: "BROKER:brk-ana-sosa" });
  }
  const scheduler = fakeScheduler();
  const deps: DispatchDeps = { data: world.stores.connector, send: (request, call) => sendOutbound(world.deps, request, call), scheduler };
  const ctx: WorkerContext = {
    log: createLogger({ correlationId: "test-dispatch-0001", level: "debug", sink: (line) => world.lines.push(line), now: () => new Date(REAL_NOW) }),
    sink: { enqueue: async () => undefined },
    now: () => new Date(REAL_NOW),
    receiveCount: 1,
  };
  return { world, deps, ctx, scheduler };
}

async function notices(world: OutboundWorld) {
  const messages = await world.stores.connector.conversations.listMessages(OPERATION);
  return messages.filter((message) => message.direction === "OUT" && message.kind === "DISPATCH_STATUS");
}

describe("notify_dispatch_status", () => {
  it("[FL-077] OFICIALIZADO on an approved dossier: META.dispatch and the template despacho_estado with the glossary text", async () => {
    const { world, deps, ctx } = await setup();
    const outcome = await notifyDispatchStatus(deps, dispatchEvent(), ctx);
    expect(outcome).toMatchObject({ status: "NOTIFIED", send: "SENT", messageId: dispatchMessageId(dispatchEvent()) });
    const operation = await world.stores.connector.operations.getOperation(OPERATION);
    expect(operation.dispatch).toMatchObject({ status: "OFICIALIZADO", history: [{ status: "OFICIALIZADO", eventId: CUSTOMS_EVENT_ID }] });
    const [notice] = await notices(world);
    expect(notice?.template).toEqual({ name: "despacho_estado", params: ["4471", DISPATCH_GLOSSARY.OFICIALIZADO.statusText, DISPATCH_GLOSSARY.OFICIALIZADO.explanation] });
    expect(notice?.author).toBe("SYSTEM");
  });

  it("[FL-077] CANAL_ASIGNADO NARANJA explains the orange channel with Reference/DISPATCH_GLOSSARY; LIBERADO cancels every pending timer", async () => {
    const { world, deps, ctx } = await setup();
    const { timers } = world.stores.connector;
    await timers.createTimer({ operationId: OPERATION, clockId: "GLOBAL#firm-delta", kind: "MILESTONE", timerId: "FOLLOWUP", dueAtSim: "2026-10-23T10:00:00-03:00", status: "SCHEDULED" });
    await notifyDispatchStatus(deps, dispatchEvent({ eventId: "evt_01JQ7ZK8X4M2N6P9R3T5V7W9Y4", status: "CANAL_ASIGNADO", channel: "NARANJA" }), ctx);
    const released = await notifyDispatchStatus(deps, dispatchEvent({ eventId: "evt_01JQ7ZK8X4M2N6P9R3T5V7W9Y5", status: "LIBERADO" }), ctx);
    expect(released).toMatchObject({ status: "NOTIFIED", closedTimers: ["TIMER#MILESTONE#FOLLOWUP"] });
    const sent = await notices(world);
    const orange = DISPATCH_GLOSSARY["CANAL_ASIGNADO#NARANJA"];
    expect(sent.map((message) => message.template?.params[1]).sort()).toEqual([orange.statusText, DISPATCH_GLOSSARY.LIBERADO.statusText].sort());
    const reference = await world.stores.connector.reference.getDispatchGlossary("CANAL_ASIGNADO", "NARANJA");
    expect(sent.find((message) => message.template?.params[1] === orange.statusText)?.template?.params[2]).toBe(reference?.text ?? orange.explanation);
    expect(await timers.listTimers(OPERATION, { status: "SCHEDULED" })).toEqual([]);
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dispatch.status).toBe("LIBERADO");
  });

  it("[FL-078] the same event run again sends one notice and records one history entry", async () => {
    const { world, deps, ctx } = await setup();
    await notifyDispatchStatus(deps, dispatchEvent(), ctx);
    await notifyDispatchStatus(deps, dispatchEvent(), ctx);
    expect(await notices(world)).toHaveLength(1);
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dispatch.history).toHaveLength(1);
  });

  it("[FL-078] a status for a dossier that is not approved records DISPATCH_BEFORE_APPROVAL and sends nothing", async () => {
    const { world, deps, ctx } = await setup({ approved: false });
    expect(await notifyDispatchStatus(deps, dispatchEvent(), ctx)).toEqual({ status: "BEFORE_APPROVAL" });
    expect(await notices(world)).toEqual([]);
    const trail = await world.stores.connector.audit.listByOperation(OPERATION);
    expect(trail.filter((decision) => decision.action === "DISPATCH_BEFORE_APPROVAL")).toHaveLength(1);
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dispatch.status).toBe("NONE");
  });

  it("refuses an event whose firm or world is not the operation's", async () => {
    const { deps, ctx } = await setup();
    await expect(notifyDispatchStatus(deps, dispatchEvent({ firmId: "firm-guest-41" }), ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
