import { describe, expect, it } from "vitest";
import { type BounceType, type SesEventType, derivedEventId, turnEventId } from "../../channels/adapter";
import { CONTACT_CHECK_DELAY_MS } from "../../channels/email/events";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { CLOCK, FIRM, OPERATION, START_SIM, type ServiceWorld, serviceWorld } from "../operations-admin/testing";
import { EMAIL_FAILURE_METRIC, applyEmailEventHandler, workerApplyEmailEvent } from "./email-event";

const MESSAGE = "msg-docsrequest1";
const WORKER = { kind: "WORKER" as const, firmId: FIRM };

async function sentEmail(world: ServiceWorld): Promise<void> {
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
    sentAtSim: START_SIM,
    sentAtReal: "2026-09-26T15:00:00.000Z",
  });
}

function emailEvent(type: SesEventType, bounceType?: BounceType) {
  return {
    type: "EMAIL_EVENT" as const,
    eventId: derivedEventId("EMAIL_EVENT", `ses-1#${type}#supplier-qingdao@sim.legajo.demo.craftech.io`),
    operationId: OPERATION,
    clockId: CLOCK,
    firmId: FIRM,
    eventAtSim: "2026-10-14T10:35:00-03:00",
    messageId: MESSAGE,
    sesEventType: type,
    occurredAtReal: "2026-09-26T15:05:00.000Z",
    ...(bounceType === undefined ? {} : { bounceType }),
  };
}

describe("apply_email_event [FL-029] [FL-031]", () => {
  it("[FL-029] a permanent bounce: message and contact BOUNCED, CONTACT_CHECK a day later, EMAIL_BOUNCED turn", async () => {
    const world = await serviceWorld();
    await sentEmail(world);
    const event = emailEvent("BOUNCE", "Permanent");
    const answer = unwrapDirect(await applyEmailEventHandler(world.deps)({ caller: WORKER, event }));
    expect(answer).toMatchObject({ applied: true, messageStatus: "BOUNCED", contactStatus: "BOUNCED", timerArmed: true, turn: true, escalated: false });
    expect(await world.stores.connector.conversations.getMessage(OPERATION, MESSAGE)).toMatchObject({ status: "BOUNCED" });
    expect(await world.stores.connector.parties.getContact("sup-qingdao", "ctc-qingdao-1")).toMatchObject({ status: "BOUNCED" });
    const [timer] = await world.stores.connector.timers.listTimers(OPERATION, { kind: "CONTACT_CHECK" });
    expect(Date.parse(timer?.dueAtSim ?? "")).toBe(Date.parse(event.eventAtSim) + CONTACT_CHECK_DELAY_MS);
    expect(world.events).toMatchObject([{ type: "AGENT_TURN", trigger: "EMAIL_BOUNCED", eventId: turnEventId("EMAIL_BOUNCED", event.eventId) }]);
    expect((await world.stores.connector.conversations.listMessageEvents(OPERATION)).map((row) => row.type)).toEqual(["BOUNCED"]);
  });

  it("[FL-029] a redelivered event converges: one message event, one timer, one audit row, the same turn id", async () => {
    const world = await serviceWorld();
    await sentEmail(world);
    const apply = workerApplyEmailEvent(world.deps);
    const context = { log: world.deps.loggerFor("c"), sink: world.deps.events, now: world.deps.wallClock, receiveCount: 1 };
    await apply(emailEvent("BOUNCE", "Permanent"), context);
    await apply(emailEvent("BOUNCE", "Permanent"), context);
    expect(await world.stores.connector.conversations.listMessageEvents(OPERATION)).toHaveLength(1);
    expect(await world.stores.connector.timers.listTimers(OPERATION, { kind: "CONTACT_CHECK" })).toHaveLength(1);
    const applied = (await world.stores.connector.audit.listByOperation(OPERATION)).filter((row) => row.action === "EMAIL_EVENT_APPLIED");
    expect(applied).toHaveLength(1);
    expect(new Set(world.events.map((event) => event.eventId)).size).toBe(1);
  });

  it("[FL-031] a complaint: COMPLAINED and NO_VALID_CONTACT escalated, without a turn", async () => {
    const world = await serviceWorld();
    await sentEmail(world);
    unwrapDirect(await applyEmailEventHandler(world.deps)({ caller: WORKER, event: emailEvent("COMPLAINT") }));
    expect(await world.stores.connector.parties.getContact("sup-qingdao", "ctc-qingdao-1")).toMatchObject({ status: "COMPLAINED" });
    expect(world.events).toMatchObject([{ type: "ESCALATE", reason: "NO_VALID_CONTACT", messageId: MESSAGE, contactId: "ctc-qingdao-1" }]);
  });

  it("a transient bounce leaves the contact ACTIVE and arms one BOUNCE_RETRY; a rejection counts for the alarm", async () => {
    const world = await serviceWorld();
    await sentEmail(world);
    const apply = applyEmailEventHandler(world.deps);
    expect(unwrapDirect(await apply({ caller: WORKER, event: emailEvent("BOUNCE", "Transient") }))).toMatchObject({ messageStatus: "DELAYED", timerArmed: true, turn: false });
    expect(await world.stores.connector.parties.getContact("sup-qingdao", "ctc-qingdao-1")).toMatchObject({ status: "ACTIVE" });
    expect(await world.stores.connector.timers.listTimers(OPERATION, { kind: "BOUNCE_RETRY" })).toHaveLength(1);
    unwrapDirect(await apply({ caller: WORKER, event: emailEvent("REJECT") }));
    expect(world.metrics(EMAIL_FAILURE_METRIC)).toHaveLength(1);
  });

  it("ignores an event of a message that is not an outbound email of the operation, and is only the worker's", async () => {
    const world = await serviceWorld();
    expect(unwrapDirect(await applyEmailEventHandler(world.deps)({ caller: WORKER, event: emailEvent("DELIVERY") }))).toEqual({ ok: true, applied: false });
    expect(await applyEmailEventHandler(world.deps)({ caller: { kind: "CONSOLE", firmId: FIRM, brokerId: "brk-delta-diego", role: "BROKER" }, event: emailEvent("DELIVERY") })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});
