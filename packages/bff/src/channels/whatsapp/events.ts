// Delivery statuses of our WhatsApp messages (docs/architecture-integrations.md §4.1): `statuses[]`
// (`sent`, `delivered`, `read`, `failed` with `errors[]`, `pricing.category`) update `Message.status`
// and leave a `MessageEvent`. Live statuses arrive by SNS; the simulated transport builds the same
// `statuses[]` items and records them through `messageEventOf`, so both modes write identical events.
// A template send billed in a category other than `utility` is logged with its metric (the alarm reads
// it); a failure is logged with its Meta error code and title, never with the recipient.
import type { NewEntity } from "../../domain/common";
import type { Message, MessageEvent, MessageEventType } from "../../domain/conversations";
import type { ConversationsPort } from "../../connector/ports-runtime";
import { sha256Hex } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import { countMetric } from "../adapter";
import { type WaStatus, type WaStatusValue, instantOf } from "./payloads";
import type { SendRecord } from "./transport";

/** Log `metric` fields the observability filters count (docs/architecture.md §12). */
export const WHATSAPP_METRICS = {
  pricingCategory: "WhatsAppPricingCategory",
  sendFailed: "WhatsAppSendFailed",
  unknownStatus: "WhatsAppStatusUnknownMessage",
} as const;

/** The only category a template send may be billed in (every template is `UTILITY`). */
export const EXPECTED_TEMPLATE_CATEGORY = "utility";

const EVENT_TYPE: Readonly<Record<WaStatusValue, MessageEventType>> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };

/** How far a status has gone: a late `delivered` never takes a `read` message back. */
const RANK: Readonly<Partial<Record<Message["status"], number>>> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

/** `wa-<status>-<sha of the wamid>`: the same status of the same message is recorded once. */
export function statusEventId(status: Pick<WaStatus, "id" | "status">): string {
  return `wa-${status.status}-${sha256Hex(status.id).slice(0, 40)}`;
}

function detailOf(status: WaStatus): Record<string, unknown> {
  const error = status.errors?.[0];
  return {
    ...(status.pricing?.category === undefined ? {} : { pricingCategory: status.pricing.category }),
    ...(error === undefined ? {} : { errorCode: error.code, ...(error.title === undefined ? {} : { errorTitle: error.title }) }),
  };
}

/** The `MessageEvent` of one status of a message, live or simulated. */
export function messageEventOf(status: WaStatus, record: SendRecord, simulated: boolean): NewEntity<typeof MessageEvent> {
  return {
    eventId: statusEventId(status),
    operationId: record.operationId,
    clockId: record.clockId,
    messageId: record.messageId,
    type: EVENT_TYPE[status.status],
    atReal: instantOf(status.timestamp),
    detail: detailOf(status),
    simulated,
  };
}

/** The status the message moves to, or `undefined` when this one would take it back. */
export function nextStatus(current: Message["status"], status: WaStatusValue): Message["status"] | undefined {
  const target = EVENT_TYPE[status];
  if (target === "FAILED") return current === "READ" || current === "FAILED" ? undefined : "FAILED";
  const from = RANK[current];
  const to = RANK[target as Message["status"]];
  if (from === undefined || to === undefined) return undefined;
  return to > from ? (target as Message["status"]) : undefined;
}

export type StatusOutcome =
  | { readonly outcome: "APPLIED"; readonly messageId: string; readonly status: Message["status"] }
  | { readonly outcome: "UNCHANGED"; readonly messageId: string }
  | { readonly outcome: "DUPLICATE"; readonly messageId: string }
  | { readonly outcome: "UNKNOWN_MESSAGE" };

export interface StatusDeps {
  readonly conversations: ConversationsPort;
  readonly log: Logger;
}

function alarmOn(status: WaStatus, message: Message, log: Logger): void {
  const refs = { operationId: message.operationId, messageId: message.messageId };
  const category = status.pricing?.category;
  if (message.template !== undefined && category !== undefined && category.toLowerCase() !== EXPECTED_TEMPLATE_CATEGORY) {
    log.error("template send billed outside the utility category", { metric: WHATSAPP_METRICS.pricingCategory, category, template: message.template.name, ...refs });
  }
  if (status.status === "failed") {
    const error = status.errors?.[0];
    log.error("whatsapp send failed", { metric: WHATSAPP_METRICS.sendFailed, errorCode: error?.code, errorTitle: error?.title, ...refs });
  }
}

/** Applies one status to the outbound WhatsApp message it names (GSI1 `providerMessageId`). */
export async function applyStatus(status: WaStatus, deps: StatusDeps, simulated: boolean): Promise<StatusOutcome> {
  const message = await deps.conversations.findMessageByProviderId(status.id);
  if (message === undefined || message.direction !== "OUT" || message.channel !== "WHATSAPP") {
    countMetric(deps.log, WHATSAPP_METRICS.unknownStatus, { status: status.status });
    return { outcome: "UNKNOWN_MESSAGE" };
  }
  const record = { operationId: message.operationId, clockId: message.clockId, messageId: message.messageId };
  const recorded = await deps.conversations.recordMessageEvent(messageEventOf(status, record, simulated));
  if (!recorded.created) return { outcome: "DUPLICATE", messageId: message.messageId };
  alarmOn(status, message, deps.log);
  const next = nextStatus(message.status, status.status);
  if (next === undefined) return { outcome: "UNCHANGED", messageId: message.messageId };
  await deps.conversations.updateMessage({ operationId: message.operationId, messageId: message.messageId, sentAtSim: message.sentAtSim }, { status: next });
  return { outcome: "APPLIED", messageId: message.messageId, status: next };
}

/** Applies the statuses of one webhook entry in the order Meta sent them. */
export async function applyStatuses(statuses: readonly WaStatus[], deps: StatusDeps, simulated: boolean): Promise<StatusOutcome[]> {
  const outcomes: StatusOutcome[] = [];
  for (const status of statuses) outcomes.push(await applyStatus(status, deps, simulated));
  return outcomes;
}
