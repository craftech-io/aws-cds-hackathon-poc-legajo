// `handle_guardrail_block` (docs/architecture.md §9.1, docs/tool-catalog.md): what the worker does when
// G1 blocked a turn, deterministically and without the model.
//
//   1. the Harness's text is never forwarded (it is the guardrail's sentinel, ADR-0011);
//   2. the answer depends on where the blocked text came from, never on what it says:
//        a message of the importer (`IMPORTER_MESSAGE`)  → the fixed `guardrailRefusal` of copy/es-AR.ts,
//                                                           `REPLY` with author `SYSTEM` through the outbound
//                                                           pipeline, answering that message (its window)
//        a supplier email, or a turn without an importer  → no outbound to anyone: a hostile supplier is
//        message (milestones, readings, ETA changes…)        never answered, an importer who did not write
//                                                           is never written to out of context
//   3. `escalate_to_broker` direct (`caller WORKER`): `OUT_OF_CHECKLIST` for a denied topic, `OTHER` with
//      the fixed summary "posible inyección" for a prompt attack and "datos de tarjeta" for card data;
//   4. `GUARDRAIL_BLOCK` audited with the policy, the origin (`PREFILTER` or `HARNESS`) and the source
//      (`IMPORTER`, `SUPPLIER`, `SYSTEM`), and the metric `GuardrailBlocks` by origin and source;
//   5. a block of the Harness raises `Operation.sessionEpoch`, so the next turn starts a clean session.
//
// The Harness does not say which policy stopped it: a block of the Harness reads as a prompt attack
// when the turn's text is a supplier's (the only hostile text such a turn holds) and as a denied topic
// otherwise (the model's own answer crossed a topic the firm answers).
//
// The fixed reply is an `OUTBOUND_SEND` event whose id derives from the blocked turn's, so a retry of
// this event never sends it twice (FIFO deduplication plus `IDEMP#OUTBOUND_SEND`).
import type { EscalationReason, GuardrailOrigin, GuardrailSource } from "@legajo/shared";
import { countMetric, derivedEventId } from "../channels/adapter";
import { firmEsAR } from "../copy/es-AR-firm";
import { importerEsAR, labelsEsAR } from "../copy/es-AR";
import type { Connector } from "../connector/index";
import type { Message } from "../domain/conversations";
import type { Operation } from "../domain/operations";
import type { Logger } from "../lib/log";
import type { G1Policy } from "../turns/prefilter";
import { WORKER_ACTIONS, auditOnce } from "./audit";
import type { OutboundSendEvent, TurnEvent } from "./events";
import type { EscalationPort } from "./ports";
import type { OperationEventSink } from "./sink";

export const GUARDRAIL_BLOCK_METRIC = "GuardrailBlocks";

/** The Harness's stop, when it was the Harness that blocked. */
export type BlockPolicy = G1Policy | "HARNESS";

export interface GuardrailBlock {
  readonly origin: GuardrailOrigin;
  readonly source: GuardrailSource;
  readonly policy: BlockPolicy;
  readonly topics?: readonly string[];
  /** `content_filtered`, `guardrail_intervened`: only for a block of the Harness. */
  readonly stopReason?: string;
}

export interface GuardrailBlockInput {
  readonly event: TurnEvent;
  readonly operation: Operation;
  readonly block: GuardrailBlock;
  /** The inbound message of the turn: the importer's one is answered with the fixed reply. */
  readonly message?: Message;
  /** The turn the Harness ran, for a block of the Harness. */
  readonly turnId?: string;
}

export interface GuardrailBlockDeps {
  readonly data: Pick<Connector, "audit" | "operations">;
  readonly escalation: EscalationPort;
  readonly sink: Pick<OperationEventSink, "enqueue">;
  readonly log: Logger;
  readonly now: () => Date;
}

export interface GuardrailBlockOutcome {
  readonly escalationId: string;
  readonly reason: EscalationReason;
  /** The fixed reply went out (an importer's message) or nothing did. */
  readonly replied: boolean;
  /** The new `sessionEpoch` after a block of the Harness. */
  readonly sessionEpoch?: number;
}

/** Reason and fixed summary of the escalation that follows a block. */
export function escalationOf(block: Pick<GuardrailBlock, "policy" | "source">): { readonly reason: EscalationReason; readonly summary: string } {
  const policy = block.policy === "HARNESS" ? (block.source === "SUPPLIER" ? "PROMPT_ATTACK" : "DENIED_TOPIC") : block.policy;
  if (policy === "DENIED_TOPIC") return { reason: "OUT_OF_CHECKLIST", summary: labelsEsAR.escalationReason.OUT_OF_CHECKLIST };
  if (policy === "CARD_DATA") return { reason: "OTHER", summary: firmEsAR.guardrailSummary.cardData };
  return { reason: "OTHER", summary: firmEsAR.guardrailSummary.promptAttack };
}

/** The fixed reply to a blocked importer message: an `OUTBOUND_SEND` with author `SYSTEM`. */
export function refusalSend(event: TurnEvent, message: Message): OutboundSendEvent {
  return {
    type: "OUTBOUND_SEND",
    eventId: derivedEventId("OUTBOUND_SEND", `GUARDRAIL_REFUSAL#${event.eventId}`),
    operationId: event.operationId,
    clockId: event.clockId,
    firmId: event.firmId,
    eventAtSim: event.eventAtSim,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    author: "SYSTEM",
    kind: "REPLY",
    channel: "WHATSAPP",
    text: importerEsAR.guardrailRefusal,
    inReplyToMessageId: message.messageId,
  };
}

/** Only an importer's own message gets the fixed reply; nothing else is ever answered after a block. */
function answersImporter(input: GuardrailBlockInput): input is GuardrailBlockInput & { readonly message: Message } {
  return input.block.source === "IMPORTER" && input.event.trigger === "IMPORTER_MESSAGE" && input.message?.direction === "IN" && input.message.counterpart === "IMPORTER";
}

export async function handleGuardrailBlock(deps: GuardrailBlockDeps, input: GuardrailBlockInput): Promise<GuardrailBlockOutcome> {
  const { event, operation, block } = input;
  const { reason, summary } = escalationOf(block);
  // Escalation first: it is idempotent (one open per reason), so a retry after any later step is safe.
  const { escalationId } = await deps.escalation.escalate({ operationId: operation.operationId, firmId: operation.firmId, eventId: event.eventId, reason, summary });
  let replied = false;
  if (answersImporter(input)) {
    await deps.sink.enqueue(refusalSend(event, input.message));
    replied = true;
  }
  await auditOnce(deps.data.audit, {
    action: WORKER_ACTIONS.guardrailBlock,
    eventId: event.eventId,
    firmId: operation.firmId,
    clockId: operation.clockId,
    operationId: operation.operationId,
    atSim: event.eventAtSim,
    atReal: deps.now().toISOString(),
    trigger: event.trigger,
    ruleIds: ["G1"],
    refs: { escalationId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }), ...(input.message === undefined ? {} : { messageId: input.message.messageId }) },
    detail: {
      policy: block.policy,
      origin: block.origin,
      source: block.source,
      replied,
      ...(block.topics === undefined || block.topics.length === 0 ? {} : { topics: [...block.topics] }),
      ...(block.stopReason === undefined ? {} : { stopReason: block.stopReason }),
    },
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
  });
  countMetric(deps.log, GUARDRAIL_BLOCK_METRIC, { origin: block.origin, source: block.source });
  if (block.origin !== "HARNESS") return { escalationId, reason, replied };
  const sessionEpoch = await deps.data.operations.nextSessionEpoch(operation.operationId);
  return { escalationId, reason, replied, sessionEpoch };
}
