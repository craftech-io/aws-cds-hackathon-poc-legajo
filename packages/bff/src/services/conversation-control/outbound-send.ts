// `OUTBOUND_SEND` (docs/architecture.md §7): a send a deterministic handler orders the outbound
// pipeline, through the operation's FIFO group so it never overtakes a turn or an intake of the same
// operation. The event is the worker's (worker/events.ts); producers in this package:
//
//   broker_send       the firm writes to the importer: `BROKER_MESSAGE`, `author BROKER:<id>`, free text
//                     inside the 24-hour window or one of the firm's templates outside it
//   approve_dossier   `legajo_aprobado`, `APPROVAL_NOTICE`, `author BROKER:<id>`
//   revoke_consent    from the channel: `OPT_OUT_CONFIRMATION`, the fixed text, `author SYSTEM`, answering
//                     the importer's message
//
// The worker hands it to the pipeline, so the policy, the window, the template, the fence and the
// transport decide exactly as for any other send. A console action has no natural key: a new
// `evt_<ULID>` (docs/architecture.md §7); the channel's derives from the `wamid`.
import type { WhatsAppTemplateName } from "@legajo/shared";
import { derivedEventId } from "../../channels/adapter";
import { importerEsAR } from "../../copy/es-AR";
import type { Actor } from "../../domain/common";
import { ulid } from "../../lib/crypto";
import { OutboundSendEvent } from "../../worker/events";

export { OutboundSendEvent } from "../../worker/events";

interface Scope {
  readonly operationId: string;
  readonly clockId: string;
  readonly firmId: string;
  /** Simulated instant of the action: the policy decides at this hour (or defers). */
  readonly eventAtSim: string;
  readonly correlationId?: string;
}

function base(scope: Scope, eventId: string) {
  return {
    type: "OUTBOUND_SEND" as const,
    eventId,
    operationId: scope.operationId,
    clockId: scope.clockId,
    firmId: scope.firmId,
    eventAtSim: scope.eventAtSim,
    ...(scope.correlationId === undefined ? {} : { correlationId: scope.correlationId.slice(0, 64) }),
  };
}

/** `evt_<ULID>`: the id of an event born of a console action. */
export function newConsoleEventId(nowMs: number): string {
  return `evt_${ulid(nowMs)}`;
}

/** The firm's message to the importer: free text, or a template with its parameters already filled. */
export function brokerMessageSend(scope: Scope & { readonly eventId: string; readonly author: Actor; readonly content: { readonly text: string } | { readonly template: WhatsAppTemplateName; readonly params: readonly string[] } }): OutboundSendEvent {
  const content = "text" in scope.content ? { text: scope.content.text } : { template: { name: scope.content.template, params: [...scope.content.params] } };
  return OutboundSendEvent.parse({ ...base(scope, scope.eventId), author: scope.author, kind: "BROKER_MESSAGE", channel: "WHATSAPP", ...content });
}

/** `legajo_aprobado` after the approval, signed by the broker who approved. */
export function approvalNoticeSend(scope: Scope & { readonly eventId: string; readonly author: Actor; readonly operationNumber: string }): OutboundSendEvent {
  return OutboundSendEvent.parse({ ...base(scope, scope.eventId), author: scope.author, kind: "APPROVAL_NOTICE", channel: "WHATSAPP", template: { name: "legajo_aprobado", params: [scope.operationNumber] } });
}

/** The fixed confirmation of an opt-out by WhatsApp, answering the importer's message (derived from its `wamid`). */
export function optOutConfirmationSend(scope: Scope & { readonly wamid: string; readonly answers: string }): OutboundSendEvent {
  return OutboundSendEvent.parse({
    ...base(scope, derivedEventId("OUTBOUND_SEND", `${scope.wamid}#OPT_OUT_CONFIRMATION`)),
    author: "SYSTEM",
    kind: "OPT_OUT_CONFIRMATION",
    channel: "WHATSAPP",
    text: importerEsAR.optOutConfirmation,
    inReplyToMessageId: scope.answers,
  });
}
