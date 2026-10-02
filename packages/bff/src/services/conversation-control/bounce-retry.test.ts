import { describe, expect, it } from "vitest";
import { derivedEventId } from "../../channels/adapter";
import type { Timer } from "../../domain/timers";
import type { OutboundRequest } from "../../outbound/types";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { CLOCK, FIRM, OPERATION, START_SIM, type ServiceWorld, serviceWorld } from "../operations-admin/testing";
import { bounceRetryAction, bounceRetryMessageId } from "./bounce-retry";
import { applyEmailEventHandler } from "./email-event";

const MESSAGE = "msg-docsrequest1";

async function delayedEmail(world: ServiceWorld): Promise<Timer> {
  await world.stores.connector.conversations.appendMessage({
    messageId: MESSAGE,
    operationId: OPERATION,
    firmId: FIRM,
    clockId: CLOCK,
    direction: "OUT",
    channel: "EMAIL",
    kind: "DOCS_REQUEST",
    counterpart: "SUPPLIER",
    contactId: "ctc-qingdao-1",
    to: "supplier-qingdao@sim.legajo.demo.craftech.io",
    from: "op-4471-k7p2q9@legajo.demo.craftech.io",
    body: "Please send the packing list.",
    status: "SENT",
    author: "AGENT",
    refs: { docTypes: ["PACKING_LIST"] },
    sentAtSim: START_SIM,
    sentAtReal: "2026-09-26T15:00:00.000Z",
  });
  const event = {
    type: "EMAIL_EVENT" as const,
    eventId: derivedEventId("EMAIL_EVENT", "ses-1#BOUNCE#transient"),
    operationId: OPERATION,
    clockId: CLOCK,
    firmId: FIRM,
    eventAtSim: "2026-10-14T10:35:00-03:00",
    messageId: MESSAGE,
    sesEventType: "BOUNCE" as const,
    bounceType: "Transient" as const,
    occurredAtReal: "2026-09-26T15:05:00.000Z",
  };
  unwrapDirect(await applyEmailEventHandler(world.deps)({ caller: { kind: "WORKER", firmId: FIRM }, event }));
  const [timer] = await world.stores.connector.timers.listTimers(OPERATION, { kind: "BOUNCE_RETRY" });
  if (timer === undefined) throw new Error("no BOUNCE_RETRY armed");
  return timer;
}

function firingOf(timer: Timer) {
  return { timer, firing: { operationId: OPERATION, clockId: CLOCK, firmId: FIRM, timerKey: `TIMER#BOUNCE_RETRY#${timer.timerId}`, version: timer.version, dueAtSim: timer.dueAtSim, eventAtSim: timer.dueAtSim, firedBy: "CLOCK" as const } };
}

describe("TIMER#BOUNCE_RETRY: one resend of a delayed email", () => {
  it("resends the delayed email verbatim through the pipeline, with a message id derived from it", async () => {
    const world = await serviceWorld();
    const timer = await delayedEmail(world);
    const sent: OutboundRequest[] = [];
    const action = bounceRetryAction({ data: world.stores.connector, send: async (request) => (sent.push(request), { status: "SENT", messageId: request.messageId ?? "" }), log: world.deps.loggerFor("test") });
    const result = await action(firingOf(timer));
    expect(result).toEqual({ outcome: "FIRED", detail: { resentAs: bounceRetryMessageId(MESSAGE), sendStatus: "SENT" } });
    expect(sent).toEqual([
      expect.objectContaining({ channel: "EMAIL", counterpart: "SUPPLIER", kind: "DOCS_REQUEST", author: "AGENT", textSource: "CODE", text: "Please send the packing list.", contactId: "ctc-qingdao-1", messageId: bounceRetryMessageId(MESSAGE), eventAtSim: timer.dueAtSim, refs: { docTypes: ["PACKING_LIST"] } }),
    ]);
  });

  it("leaves a message SES settled in between, and a payload it cannot read", async () => {
    const world = await serviceWorld();
    const timer = await delayedEmail(world);
    const message = await world.stores.connector.conversations.getMessage(OPERATION, MESSAGE);
    if (message === undefined) throw new Error("missing message");
    await world.stores.connector.conversations.updateMessage({ operationId: OPERATION, messageId: MESSAGE, sentAtSim: message.sentAtSim }, { status: "DELIVERED" }, message.version);
    const send = async (): Promise<never> => {
      throw new Error("nothing is sent");
    };
    const action = bounceRetryAction({ data: world.stores.connector, send, log: world.deps.loggerFor("test") });
    expect(await action(firingOf(timer))).toEqual({ outcome: "SKIPPED", reason: "MESSAGE_SETTLED" });
    expect(await action(firingOf({ ...timer, payload: { other: true } }))).toEqual({ outcome: "SKIPPED", reason: "PAYLOAD_INVALID" });
  });
});
