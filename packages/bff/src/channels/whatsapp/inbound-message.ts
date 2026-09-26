// One message of the importer, in the order docs/design-brief.md §5.1 fixes for `IMPORTER_MESSAGE`,
// all of it without the model: identity by the registered phone (its world is where the message
// counts), idempotency by `wamid` (marked once the effect is on record) and the world's hourly limit
// (channels/rate-limit.ts), button nonces, opt-out by button or keyword, media into `Media`, text
// masked by channels/normalizer.ts before it is stored, and the routing to one operation (or the
// `OPERATION_CHOICE` list). What the adapter decides it records (`Message IN`, `AuditLog`); what
// follows it asks of the ports (a turn or an intake on the FIFO, a fixed reply through the outbound
// pipeline, `revoke_consent`, `confirm_supplier_contact`).
import type { WaButtonAction } from "@legajo/shared";
import type { MessageAttachment } from "../../domain/conversations";
import type { Operation } from "../../domain/operations";
import type { Importer } from "../../domain/parties";
import type { Nonce } from "../../domain/runtime";
import { simNowOf } from "../../lib/clock";
import { phoneHash } from "../../lib/crypto";
import { INBOUND_IDEMPOTENCY_SOURCE, PDF_MIME_TYPE } from "./config";
import { type InboundContext, type MessageResult, ambiguousSender, rateLimited, reply, unknownSender } from "./inbound-senders";
import { type AcceptedMedia, acceptDocument, mediaObjectOf, routeMedia } from "./media";
import { type NonceRefusal, choicePayloadOf, consumeNonce, contactPayloadOf, resolveNonce } from "./nonces";
import { isOptOutKeyword } from "./opt-out";
import { type WaInboundMessage, e164Of, instantOf } from "./payloads";
import { type NormalizedText, normalizeInboundText } from "../normalizer";
import { type InboundDelivery, admitInbound, completeInbound, isProcessed, rateLimitOf } from "../rate-limit";
import { appendInbound, derivedMessageId, importerTurn, recordDecision } from "./records";
import { applyOperationChoice, offerOperationChoice, openOperationsOf } from "./routing";

export type { InboundContext, MessageOutcome, MessageResult } from "./inbound-senders";

interface Sender {
  readonly importer: Importer;
  readonly hash: string;
  readonly atSim: string;
  readonly atReal: string;
  readonly now: Date;
  readonly qaRunId?: string;
  readonly operations: readonly Operation[];
}

/** A tap on one of our buttons: the nonce and what the importer saw. */
function replyOf(message: WaInboundMessage): { readonly nonce: string; readonly title: string } | undefined {
  if (message.type === "button" && message.button !== undefined) return { nonce: message.button.payload, title: message.button.text };
  const interactive = message.interactive;
  const answer = interactive?.type === "button_reply" ? interactive.button_reply : interactive?.type === "list_reply" ? interactive.list_reply : undefined;
  return answer === undefined ? undefined : { nonce: answer.id, title: answer.title };
}

/** Everything of the message that still needs an operation. */
interface Unrouted {
  readonly body: NormalizedText;
  readonly hasText: boolean;
  readonly attachments: readonly MessageAttachment[];
  readonly media: readonly AcceptedMedia[];
  readonly rejected?: "rejectedMedia" | "mediaTooLarge";
  readonly button?: { readonly action: WaButtonAction; readonly resolved: false };
}

async function route(ctx: InboundContext, sender: Sender, message: WaInboundMessage, unrouted: Unrouted): Promise<MessageResult> {
  const { deps } = ctx;
  const wamid = message.id;
  const [target] = sender.operations;
  if (target === undefined) {
    for (const media of unrouted.media) await deps.media.delete(media.objectKey);
    await recordDecision(deps.data, { firmId: sender.importer.firmId, clockId: sender.importer.clockId, decision: "DENY", action: "NO_OPEN_OPERATION", atSim: sender.atSim, atReal: sender.atReal, importerId: sender.importer.importerId, wamid });
    return { wamid, outcome: "NO_OPEN_OPERATION" };
  }
  const persisted = await appendInbound(deps.data, {
    wamid,
    importer: sender.importer,
    operationId: target.operationId,
    to: ctx.to,
    body: unrouted.body,
    simulated: ctx.simulated,
    sentAtSim: sender.atSim,
    sentAtReal: sender.atReal,
    attachments: unrouted.attachments,
    ...(message.context?.id === undefined ? {} : { contextWamid: message.context.id }),
    ...(unrouted.button === undefined ? {} : { button: unrouted.button }),
  });
  const base = { wamid, operationId: target.operationId, messageId: persisted.messageId };
  if (unrouted.rejected !== undefined) await reply(ctx, { key: unrouted.rejected, importer: sender.importer, operationId: target.operationId, source: persisted, atSim: sender.atSim });
  if (sender.operations.length > 1 && (unrouted.hasText || unrouted.media.length > 0)) {
    await offerOperationChoice(deps, { importer: sender.importer, phoneHash: sender.hash, wamid, operations: sender.operations, source: { messageId: persisted.messageId, hasText: unrouted.hasText, media: unrouted.media }, atSim: sender.atSim, now: sender.now });
    return { ...base, outcome: "OPERATION_CHOICE" };
  }
  if (sender.operations.length === 1 && unrouted.hasText) {
    await deps.events.enqueue(importerTurn({ importer: sender.importer, operationId: target.operationId, messageId: persisted.messageId, wamid, atSim: sender.atSim }));
  }
  for (const media of unrouted.media) {
    await routeMedia(deps.data, deps.events, { ...media, operationId: target.operationId, clockId: sender.importer.clockId, firmId: sender.importer.firmId, messageId: persisted.messageId, eventAtSim: sender.atSim }, sender.atReal);
  }
  if (unrouted.media.length > 0) return { ...base, outcome: "DOCUMENT" };
  if (unrouted.rejected !== undefined) return { ...base, outcome: "MEDIA_REJECTED" };
  return { ...base, outcome: unrouted.hasText ? "TURN" : "EMPTY" };
}

async function optOut(ctx: InboundContext, sender: Sender, message: WaInboundMessage, body: NormalizedText, via: "BUTTON" | "KEYWORD", operationId?: string): Promise<MessageResult> {
  const { deps } = ctx;
  const target = operationId ?? sender.operations[0]?.operationId;
  const persisted =
    target === undefined
      ? undefined
      : await appendInbound(deps.data, {
          wamid: message.id,
          importer: sender.importer,
          operationId: target,
          to: ctx.to,
          body,
          simulated: ctx.simulated,
          sentAtSim: sender.atSim,
          sentAtReal: sender.atReal,
          ...(via === "BUTTON" ? { button: { action: "OPT_OUT", resolved: true } } : {}),
        });
  const operationIds = [...new Set([...(target === undefined ? [] : [target]), ...sender.operations.map((operation) => operation.operationId)])];
  await deps.services.revokeConsent({ importerId: sender.importer.importerId, firmId: sender.importer.firmId, clockId: sender.importer.clockId, operationIds, messageId: persisted?.messageId ?? derivedMessageId(message.id), wamid: message.id, atSim: sender.atSim, via });
  return { wamid: message.id, outcome: "OPTED_OUT", ...(target === undefined ? {} : { operationId: target }), ...(persisted === undefined ? {} : { messageId: persisted.messageId }) };
}

async function button(ctx: InboundContext, sender: Sender, message: WaInboundMessage, nonce: Nonce, title: string): Promise<MessageResult> {
  const { deps } = ctx;
  const body = normalizeInboundText(title);
  if (nonce.action === "OPT_OUT") {
    const result = await optOut(ctx, sender, message, body, "BUTTON", nonce.operationId);
    await consumeNonce(deps.data.runtime, deps.keys.nonce, nonce, sender.now);
    return result;
  }
  const persisted = await appendInbound(deps.data, {
    wamid: message.id,
    importer: sender.importer,
    operationId: nonce.operationId,
    to: ctx.to,
    body,
    simulated: ctx.simulated,
    sentAtSim: sender.atSim,
    sentAtReal: sender.atReal,
    button: { action: nonce.action, resolved: true },
    ...(message.context?.id === undefined ? {} : { contextWamid: message.context.id }),
  });
  const base = { wamid: message.id, operationId: nonce.operationId, messageId: persisted.messageId };
  const scope = { importerId: sender.importer.importerId, firmId: sender.importer.firmId, clockId: sender.importer.clockId };
  let result: MessageResult;
  const contact = contactPayloadOf(nonce);
  const choice = choicePayloadOf(nonce);
  if ((nonce.action === "CONFIRM_CONTACT" || nonce.action === "REJECT_CONTACT") && contact !== undefined) {
    await deps.services.confirmContact({ ...scope, operationId: nonce.operationId, ...contact, decision: nonce.action === "CONFIRM_CONTACT" ? "CONFIRM" : "REJECT", messageId: persisted.messageId, wamid: message.id, atSim: sender.atSim });
    result = { ...base, outcome: "CONTACT_DECISION" };
  } else if (nonce.action === "QUESTION") {
    await reply(ctx, { key: "questionPrompt", importer: sender.importer, operationId: nonce.operationId, source: persisted, atSim: sender.atSim });
    result = { ...base, outcome: "QUESTION_PROMPT" };
  } else if (nonce.action === "CHOOSE_OPERATION" && choice !== undefined) {
    const applied = await applyOperationChoice(deps, { nonce, payload: choice, importer: sender.importer, atSim: sender.atSim, atReal: sender.atReal });
    result = { wamid: message.id, outcome: "CHOICE_APPLIED", operationId: applied.operationId, messageId: applied.messageId };
  } else {
    await deps.events.enqueue(importerTurn({ importer: sender.importer, operationId: nonce.operationId, messageId: persisted.messageId, wamid: message.id, atSim: sender.atSim }));
    result = { ...base, outcome: "TURN" };
  }
  await consumeNonce(deps.data.runtime, deps.keys.nonce, nonce, sender.now);
  return result;
}

async function refusedNonce(ctx: InboundContext, sender: Sender, message: WaInboundMessage, reason: NonceRefusal, nonce: Nonce | undefined): Promise<void> {
  // A nonce of the same world names the operation it was issued for; otherwise the anchor of the sender.
  const operationId = nonce !== undefined && nonce.clockId === sender.importer.clockId ? nonce.operationId : sender.operations[0]?.operationId;
  await recordDecision(ctx.deps.data, {
    firmId: sender.importer.firmId,
    clockId: sender.importer.clockId,
    decision: "DENY",
    action: reason,
    atSim: sender.atSim,
    atReal: sender.atReal,
    importerId: sender.importer.importerId,
    wamid: message.id,
    ...(operationId === undefined ? {} : { operationId }),
  });
}

async function content(ctx: InboundContext, sender: Sender, message: WaInboundMessage): Promise<MessageResult> {
  const { deps } = ctx;
  const tapped = replyOf(message);
  let refusedAction: WaButtonAction | undefined;
  if (tapped !== undefined) {
    const resolution = await resolveNonce(deps.data, { value: tapped.nonce, importer: sender.importer, phoneHash: sender.hash, now: sender.now, ...(message.context?.id === undefined ? {} : { contextWamid: message.context.id }) });
    if (resolution.ok) return button(ctx, sender, message, resolution.nonce, tapped.title);
    await refusedNonce(ctx, sender, message, resolution.reason, resolution.nonce);
    refusedAction = resolution.nonce?.action;
  }
  const raw = tapped?.title ?? message.text?.body ?? mediaObjectOf(message)?.caption ?? "";
  const body = normalizeInboundText(raw);
  const asText = tapped !== undefined || message.type === "text";
  if (asText && isOptOutKeyword(raw)) return optOut(ctx, sender, message, body, "KEYWORD");
  const refused = refusedAction === undefined ? {} : { button: { action: refusedAction, resolved: false as const } };
  if (asText) return route(ctx, sender, message, { body, hasText: body.text !== "", attachments: [], media: [], ...refused });
  const document = message.type === "document" ? message.document : undefined;
  if (document === undefined || sender.operations.length === 0) {
    const media = mediaObjectOf(message);
    const attachment: MessageAttachment = { index: 0, contentType: media?.mime_type ?? `whatsapp/${message.type}`, sizeBytes: 0, status: "REJECTED", reason: "NOT_PDF" };
    return route(ctx, sender, message, { body, hasText: body.text !== "", attachments: [attachment], media: [], rejected: "rejectedMedia" });
  }
  const verdict = await acceptDocument(deps.transport, deps.media, { wamid: message.id, document, clockId: sender.importer.clockId, ...(sender.qaRunId === undefined ? {} : { qaRunId: sender.qaRunId }) });
  const filename = document.filename === undefined ? {} : { filename: document.filename.slice(0, 255) };
  if (!verdict.accepted) {
    const attachment: MessageAttachment = { index: 0, ...filename, contentType: verdict.contentType.slice(0, 128), sizeBytes: verdict.sizeBytes, status: "REJECTED", reason: verdict.reason };
    return route(ctx, sender, message, { body, hasText: false, attachments: [attachment], media: [], rejected: verdict.reason === "TOO_LARGE" ? "mediaTooLarge" : "rejectedMedia" });
  }
  const attachment: MessageAttachment = { index: 0, ...filename, contentType: PDF_MIME_TYPE, sizeBytes: verdict.sizeBytes, status: "ACCEPTED", s3Key: verdict.objectKey };
  const accepted: AcceptedMedia = { objectKey: verdict.objectKey, sha256: verdict.sha256, sizeBytes: verdict.sizeBytes };
  return route(ctx, sender, message, { body, hasText: false, attachments: [attachment], media: [accepted] });
}

async function fromImporter(ctx: InboundContext, importer: Importer, hash: string, message: WaInboundMessage, now: Date): Promise<MessageResult> {
  const clock = await ctx.deps.data.world.getClock(importer.clockId);
  const atSim = simNowOf(clock, now.getTime()).toISOString();
  const operations = await openOperationsOf(ctx.deps.data, importer);
  const sender: Sender = { importer, hash, atSim, atReal: instantOf(message.timestamp), now, operations, ...(clock.runId === undefined ? {} : { qaRunId: clock.runId }) };
  // A `wamid` already processed is dropped before it counts; past the world's hourly limit, no turn.
  const admission = await admitInbound(ctx.deps.data.runtime, {
    delivery: deliveryOf(message),
    clockId: importer.clockId,
    addressHash: hash,
    simNow: new Date(atSim),
    limitPerHour: rateLimitOf(clock),
  });
  if (admission.outcome === "DUPLICATE") return { wamid: message.id, outcome: "DUPLICATE" };
  if (admission.outcome === "RATE_LIMITED") return rateLimited(ctx, { importer, operations, message, atSim, atReal: sender.atReal, first: admission.count === admission.limit + 1 });
  return content(ctx, sender, message);
}

function deliveryOf(message: WaInboundMessage): InboundDelivery {
  return { source: INBOUND_IDEMPOTENCY_SOURCE, id: message.id };
}

async function identifyAndProcess(ctx: InboundContext, message: WaInboundMessage, now: Date): Promise<MessageResult> {
  const { deps } = ctx;
  const phone = e164Of(message.from);
  const hash = phoneHash(deps.keys.phoneHash, phone);
  const identity = await deps.data.parties.findImporterByPhoneHash(hash);
  if (identity.status === "UNIQUE") return fromImporter(ctx, identity.value, hash, message, now);
  // Without an importer there is no world to count in: the `wamid` mark alone keeps a repeat out.
  if (await isProcessed(deps.data.runtime, deliveryOf(message))) return { wamid: message.id, outcome: "DUPLICATE" };
  return identity.status === "NONE" ? unknownSender(ctx, { phone, hash, message, now }) : ambiguousSender(ctx, { ids: identity.ids, message, now });
}

/**
 * Processes one inbound message; a message already processed (same `wamid`) does nothing again. The
 * `wamid` is marked processed only after its effect is on record: if anything on the way fails, the
 * Lambda fails and the redelivery runs the message again (every write on the way is keyed by the
 * `wamid`, so nothing is doubled).
 */
export async function processInboundMessage(ctx: InboundContext, message: WaInboundMessage): Promise<MessageResult> {
  const now = await ctx.deps.realClock.now();
  const result = await identifyAndProcess(ctx, message, now);
  if (result.outcome === "DUPLICATE") return result;
  await completeInbound(ctx.deps.data.runtime, deliveryOf(message), now.toISOString(), {
    outcome: result.outcome,
    ...(result.operationId === undefined ? {} : { operationId: result.operationId }),
    ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
  });
  return result;
}
