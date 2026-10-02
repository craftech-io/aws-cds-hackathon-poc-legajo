import { describe, expect, it } from "vitest";
import { derivedEventId } from "../channels/adapter";
import type { WhatsAppSend } from "../outbound/types";
import type { TurnEvent } from "../worker/events";
import { CLOCK, FIRM, OPERATION, handlersOf, timeWorld } from "./testing";

function milestoneTurn(milestone: TurnEvent["milestone"]): TurnEvent {
  return {
    type: "AGENT_TURN",
    eventId: derivedEventId("AGENT_TURN", `MILESTONE#${milestone}`),
    operationId: OPERATION,
    clockId: CLOCK,
    firmId: FIRM,
    eventAtSim: "2026-10-15T10:00:00-03:00",
    trigger: "MILESTONE",
    intakeEventIds: [],
    docVersionIds: [],
    ...(milestone === undefined ? {} : { milestone }),
    timerKey: `TIMER#MILESTONE#${milestone}`,
  };
}

describe("fallback of the first request [FL-097]", () => {
  for (const cause of ["HARNESS_ERROR", "TIMEOUT", "GUARDRAIL", "INCOMPLETE"] as const) {
    it(`[FL-097] a ${cause} of the DOCS_REQUEST turn sends legajo_docs_pendientes with the tools' parameters and audits AGENT_FALLBACK`, async () => {
      const world = await timeWorld();
      await world.validate("COMMERCIAL_INVOICE");
      const event = milestoneTurn("DOCS_REQUEST");
      await handlersOf(world).milestoneFallback({ event, turnId: "turn-T0001", cause }, world.workerContext());
      expect(world.sent).toHaveLength(1);
      const request = world.sent[0]?.request as WhatsAppSend;
      expect(request).toMatchObject({
        channel: "WHATSAPP",
        kind: "DOCS_REQUEST",
        author: "SYSTEM",
        textSource: "CODE",
        trigger: "MILESTONE",
        template: { name: "legajo_docs_pendientes", params: ["Estudio Delta", "4471", "Austral Aurora", "22/10", "packing list y certificado de origen"] },
      });
      const audit = await world.connector.audit.listByOperation(OPERATION);
      expect(audit.find((row) => row.action === "AGENT_FALLBACK")).toMatchObject({ reason: cause, actor: "SYSTEM" });
    });
  }

  it("[FL-097] a repeated GROUNDING_FAIL ends the turn without a request: the fallback runs once per turn event", async () => {
    const world = await timeWorld();
    const event = milestoneTurn("DOCS_REQUEST");
    const handlers = handlersOf(world);
    await handlers.milestoneFallback({ event, turnId: "turn-T0001", cause: "INCOMPLETE" }, world.workerContext());
    await handlers.milestoneFallback({ event, turnId: "turn-T0001", cause: "INCOMPLETE" }, world.workerContext());
    expect(new Set(world.sent.map((sent) => sent.request.messageId)).size).toBe(1);
    const audit = await world.connector.audit.listByOperation(OPERATION);
    expect(audit.filter((row) => row.action === "AGENT_FALLBACK")).toHaveLength(1);
  });

  it("[FL-097] other milestones have no fallback; a complete dossier needs none", async () => {
    const world = await timeWorld();
    const handlers = handlersOf(world);
    await handlers.milestoneFallback({ event: milestoneTurn("FOLLOWUP"), cause: "TIMEOUT" }, world.workerContext());
    await world.validate("COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN");
    await handlers.milestoneFallback({ event: milestoneTurn("DOCS_REQUEST"), cause: "TIMEOUT" }, world.workerContext());
    expect(world.sent).toHaveLength(0);
  });
});
