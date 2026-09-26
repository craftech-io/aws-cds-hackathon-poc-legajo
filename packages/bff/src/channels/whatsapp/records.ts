// What the inbound adapter writes: the `Message IN` of the importer (its text through the channels'
// normalizer, masked and capped before it is stored; never the profile name) with an id derived from
// the `wamid` and the operation, so a redelivery writes nothing new, and the decisions it takes without
// the model (`AuditLog`).
import { ConnectorError, type AuditDecision, type WaButtonAction } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import type { NewEntity } from "../../domain/common";
import type { Message, MessageAttachment } from "../../domain/conversations";
import type { Importer } from "../../domain/parties";
import { sha256Hex } from "../../lib/crypto";
import { AgentTurnEvent, turnEventId } from "../adapter";
import type { NormalizedText } from "../normalizer";

/** `msg-<32 hex>` of the `Message IN` of `wamid` in `operationId` (or of a reply `kind` to it). */
export function derivedMessageId(...parts: readonly string[]): string {
  return `msg-${sha256Hex(parts.join("#")).slice(0, 32)}`;
}

export interface InboundRecord {
  readonly wamid: string;
  readonly importer: Pick<Importer, "importerId" | "firmId" | "clockId" | "phoneE164">;
  readonly operationId: string;
  /** Our phone number as the envelope names it (`simulated` in simulated mode). */
  readonly to: string;
  /** The text as `normalizeInboundText` of channels/normalizer.ts left it (masked, capped). */
  readonly body: Pick<NormalizedText, "text" | "truncated">;
  readonly simulated: boolean;
  readonly sentAtSim: string;
  readonly sentAtReal: string;
  readonly contextWamid?: string;
  readonly attachments?: readonly MessageAttachment[];
  /** What the importer tapped (never the nonce itself). */
  readonly button?: { readonly action: WaButtonAction; readonly resolved: boolean };
  /** A copy written in the operation the importer chose (FL-019): points to the original. */
  readonly routedFrom?: { readonly operationId: string; readonly messageId: string };
  /** `RECEIVED` unless the message crossed the rate limit (`DISCARDED`). */
  readonly status?: "RECEIVED" | "DISCARDED";
}

export function inboundMessage(record: InboundRecord): NewEntity<typeof Message> {
  const interactive = {
    ...(record.button === undefined ? {} : { buttonAction: record.button.action, buttonResolved: record.button.resolved }),
    ...(record.routedFrom === undefined ? {} : { routedFrom: record.routedFrom }),
  };
  return {
    messageId: derivedMessageId(record.wamid, record.operationId),
    operationId: record.operationId,
    firmId: record.importer.firmId,
    clockId: record.importer.clockId,
    direction: "IN",
    channel: "WHATSAPP",
    counterpart: "IMPORTER",
    importerId: record.importer.importerId,
    to: record.to,
    from: record.importer.phoneE164,
    body: record.body.text,
    truncated: record.body.truncated,
    status: record.status ?? "RECEIVED",
    // A routed copy leaves GSI1 to the original: one `wamid`, one message found by it.
    ...(record.routedFrom === undefined ? { providerMessageId: record.wamid } : {}),
    ...(record.contextWamid === undefined ? {} : { inReplyTo: record.contextWamid }),
    ...(Object.keys(interactive).length === 0 ? {} : { interactive }),
    author: "IMPORTER",
    trusted: true,
    simulated: record.simulated,
    sentAtSim: record.sentAtSim,
    sentAtReal: record.sentAtReal,
    attachments: [...(record.attachments ?? [])],
  };
}

/** Writes the `Message IN` once; a redelivery finds the row already there and keeps it. */
export async function appendInbound(data: Pick<Connector, "conversations">, record: InboundRecord): Promise<Message> {
  const message = inboundMessage(record);
  try {
    return await data.conversations.appendMessage(message);
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    const existing = await data.conversations.getMessage(message.operationId, message.messageId);
    if (existing === undefined) throw error;
    return existing;
  }
}

export interface AdapterDecision {
  readonly firmId: string;
  readonly clockId?: string;
  readonly operationId?: string;
  readonly decision: AuditDecision;
  readonly action: string;
  readonly atSim?: string;
  readonly atReal: string;
  readonly reason?: string;
  readonly messageId?: string;
  readonly importerId?: string;
  readonly wamid?: string;
}

/** A decision of the adapter (`actor SYSTEM`); the `wamid` only ever travels hashed. */
export async function recordDecision(data: Pick<Connector, "audit">, input: AdapterDecision): Promise<void> {
  await data.audit.record({
    firmId: input.firmId,
    decision: input.decision,
    action: input.action,
    actor: "SYSTEM",
    trigger: "IMPORTER_MESSAGE",
    atReal: input.atReal,
    ...(input.atSim === undefined ? {} : { atSim: input.atSim }),
    ...(input.clockId === undefined ? {} : { clockId: input.clockId }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    refs: {
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(input.importerId === undefined ? {} : { importerId: input.importerId }),
    },
    ...(input.wamid === undefined ? {} : { detail: { wamidHash: sha256Hex(input.wamid).slice(0, 16) } }),
  });
}

/**
 * The `IMPORTER_MESSAGE` turn of a message of the importer in an operation. Its id derives from the
 * `wamid` of the message (docs/architecture.md §7), so a redelivery, or a second choice of operation
 * for the same text, is the same event and runs once.
 */
export function importerTurn(input: { readonly importer: Pick<Importer, "firmId" | "clockId">; readonly operationId: string; readonly messageId: string; readonly wamid: string; readonly atSim: string }): AgentTurnEvent {
  return AgentTurnEvent.parse({
    type: "AGENT_TURN",
    eventId: turnEventId("IMPORTER_MESSAGE", input.wamid),
    trigger: "IMPORTER_MESSAGE",
    operationId: input.operationId,
    clockId: input.importer.clockId,
    firmId: input.importer.firmId,
    eventAtSim: input.atSim,
    messageId: input.messageId,
  });
}
