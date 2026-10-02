// What escalations (docs/design-brief.md §5.8) and the deterministic milestones need besides the
// connector: the one outbound pipeline (outbound/pipeline.ts `sendOutbound`, bound to the stage's
// `OutboundDeps`), real time and a logger. Every message to the firm's mailbox and every notice to the
// importer goes through the pipeline (ADR-0011): never a direct SES or WhatsApp call from here.
import { STAGE_DOMAIN } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import type { Logger } from "../lib/log";
import { sha256Hex } from "../lib/crypto";
import type { OutboundCall, OutboundRequest, OutboundResult } from "../outbound/types";
import { ARGENTINA_TIME_ZONE, zonedParts } from "../services/business-hours";

/** The outbound pipeline: `(request, call) => sendOutbound(stageDeps, request, call)`. */
export type OutboundSender = (request: OutboundRequest, call: OutboundCall) => Promise<OutboundResult>;

export interface EscalationDeps {
  readonly data: Pick<Connector, "operations" | "documents" | "conversations" | "parties" | "firms" | "runtime">;
  readonly send: OutboundSender;
  /** Real time: `openedAtReal`, the real day of the `UNTRUSTED_SENDER` cap. */
  readonly wallClock: () => Date;
  readonly log: Logger;
}

/** The dossier of an operation in the console (packages/web/src/routes.ts `dossierPath`). */
export function consoleUrlOf(operationId: string): string {
  return `https://${STAGE_DOMAIN}/app/operations/${encodeURIComponent(operationId)}`;
}

/** "15/10 10:00": a simulated instant on Argentina's wall clock (the firm reads it). */
export function argentinaText(iso: string): string {
  const parts = zonedParts(new Date(iso), ARGENTINA_TIME_ZONE);
  const [, month = "", day = ""] = parts.date.split("-");
  return `${day}/${month} ${parts.time}`;
}

/**
 * A message id derived from what the message is about, so a redelivered event that runs the same
 * escalation again never sends twice (the pipeline records the first and refuses a repeated id).
 */
export function derivedMessageId(...parts: readonly string[]): string {
  return `msg-${sha256Hex(parts.join("#")).slice(0, 26)}`;
}
