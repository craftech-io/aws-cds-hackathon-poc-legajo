// Senders the adapter answers without a turn (docs/architecture.md §13, FL-093, FL-094): a number with
// no importer gets a fixed reply (once per real day and number, so nobody can make us write in a loop)
// and is audited in the firm of the world that leased that number, if any; two importers with one
// phone hash are an audited error, never an identity; an importer over the hourly limit of its world
// gets one fixed reply and one `DENY RATE_LIMIT` per hour, and the rest of that hour is dropped.
import { parseClockId } from "@legajo/shared";
import { importerEsAR } from "../../copy/es-AR";
import { isExpired } from "../../domain/common";
import type { Message } from "../../domain/conversations";
import type { Operation } from "../../domain/operations";
import type { Importer } from "../../domain/parties";
import { countMetric } from "../adapter";
import { toMetaMessage } from "./meta-message";
import type { WaInboundMessage } from "./payloads";
import type { SystemReplyRequest, WhatsAppInboundDeps } from "./ports";
import { normalizeInboundText } from "../normalizer";
import { appendInbound, derivedMessageId, recordDecision } from "./records";

export interface InboundContext {
  readonly deps: WhatsAppInboundDeps;
  /** The envelope came from the phone simulator. */
  readonly simulated: boolean;
  /** Our number as the envelope names it (`metadata.phone_number_id`). */
  readonly to: string;
}

export type MessageOutcome =
  | "DUPLICATE"
  | "UNKNOWN_SENDER"
  | "AMBIGUOUS_SENDER"
  | "NO_OPEN_OPERATION"
  | "RATE_LIMITED"
  | "OPTED_OUT"
  | "CONTACT_DECISION"
  | "QUESTION_PROMPT"
  | "TURN"
  | "OPERATION_CHOICE"
  | "CHOICE_APPLIED"
  | "DOCUMENT"
  | "MEDIA_REJECTED"
  | "EMPTY";

export interface MessageResult {
  readonly wamid: string;
  readonly outcome: MessageOutcome;
  readonly operationId?: string;
  /** The `Message IN` written for it, when there is one. */
  readonly messageId?: string;
}

/** Log `metric` fields of the inbound path (docs/architecture.md §12). */
export const INBOUND_METRICS = {
  unknownSender: "WhatsAppUnknownSender",
  ambiguous: "WhatsAppIdentityAmbiguous",
  rateLimited: "WhatsAppRateLimited",
} as const;

/** `IDEMP#WA_UNKNOWN_REPLY#<phone hash>#<real day>`: one reply per unregistered number and day. */
export const UNKNOWN_REPLY_SOURCE = "WA_UNKNOWN_REPLY";

type ReplyKey = Exclude<SystemReplyRequest["textKey"], "operationChoice">;

/** A fixed text of `copy/es-AR.ts` in answer to a `Message IN`, through the outbound pipeline. */
export async function reply(ctx: InboundContext, input: { readonly key: ReplyKey; readonly importer: Importer; readonly operationId: string; readonly source: Message; readonly atSim: string }): Promise<void> {
  const wamid = input.source.providerMessageId ?? input.source.messageId;
  await ctx.deps.replies.reply({
    kind: "REPLY",
    textKey: input.key,
    body: importerEsAR[input.key],
    operationId: input.operationId,
    importerId: input.importer.importerId,
    firmId: input.importer.firmId,
    clockId: input.importer.clockId,
    messageId: derivedMessageId(wamid, input.key),
    inReplyTo: { messageId: input.source.messageId, wamid },
    atSim: input.atSim,
    buttons: [],
  });
}

/** The firm of the world that holds the lease of a number (the QA phone reserve), if any. */
async function leaseHolder(deps: WhatsAppInboundDeps, phone: string, now: Date): Promise<{ readonly firmId: string; readonly clockId: string } | undefined> {
  const lease = await deps.data.world.getLease("PHONE", phone);
  if (lease === undefined || isExpired(lease.expiresAt, now) || parseClockId(lease.holder) === undefined) return undefined;
  const clock = await deps.data.world.findClock(lease.holder);
  return clock === undefined ? undefined : { firmId: clock.firmId, clockId: clock.clockId };
}

export async function unknownSender(ctx: InboundContext, input: { readonly phone: string; readonly hash: string; readonly message: WaInboundMessage; readonly now: Date }): Promise<MessageResult> {
  const { deps } = ctx;
  const atReal = input.now.toISOString();
  countMetric(deps.log, INBOUND_METRICS.unknownSender, { phoneHash: input.hash.slice(0, 16) });
  const holder = await leaseHolder(deps, input.phone, input.now);
  if (holder !== undefined) await recordDecision(deps.data, { ...holder, decision: "DENY", action: "UNKNOWN_SENDER", atReal, wamid: input.message.id });
  if (await deps.data.runtime.claimIdempotency({ source: UNKNOWN_REPLY_SOURCE, id: `${input.hash}#${atReal.slice(0, 10)}`, atReal })) {
    try {
      await deps.transport.send({ message: toMetaMessage({ kind: "text", to: input.phone, body: importerEsAR.unknownSender }) });
    } catch (error) {
      // Live WhatsApp only writes to registered demo phones: the refusal is expected, not a failure.
      deps.log.warn("fixed reply to an unregistered number not sent", { reason: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { wamid: input.message.id, outcome: "UNKNOWN_SENDER" };
}

export async function ambiguousSender(ctx: InboundContext, input: { readonly ids: readonly string[]; readonly message: WaInboundMessage; readonly now: Date }): Promise<MessageResult> {
  const { deps } = ctx;
  deps.log.error("two importers share one phone hash", { metric: INBOUND_METRICS.ambiguous, count: input.ids.length });
  for (const importerId of input.ids) {
    const importer = await deps.data.parties.findImporter(importerId);
    if (importer === undefined) continue;
    await recordDecision(deps.data, { firmId: importer.firmId, clockId: importer.clockId, decision: "DENY", action: "IDENTITY_AMBIGUOUS", atReal: input.now.toISOString(), importerId, wamid: input.message.id });
  }
  return { wamid: input.message.id, outcome: "AMBIGUOUS_SENDER" };
}

export interface RateLimitedInput {
  readonly importer: Importer;
  readonly operations: readonly Operation[];
  readonly message: WaInboundMessage;
  readonly atSim: string;
  readonly atReal: string;
  /** The first message over the limit in this simulated hour. */
  readonly first: boolean;
}

export async function rateLimited(ctx: InboundContext, input: RateLimitedInput): Promise<MessageResult> {
  const { deps } = ctx;
  const { importer, message } = input;
  countMetric(deps.log, INBOUND_METRICS.rateLimited, { first: input.first });
  const anchor = input.operations[0];
  if (!input.first) return { wamid: message.id, outcome: "RATE_LIMITED" };
  const scope = { firmId: importer.firmId, clockId: importer.clockId };
  await recordDecision(deps.data, { ...scope, decision: "DENY", action: "RATE_LIMIT", atSim: input.atSim, atReal: input.atReal, importerId: importer.importerId, wamid: message.id, ...(anchor === undefined ? {} : { operationId: anchor.operationId }) });
  if (anchor === undefined) return { wamid: message.id, outcome: "RATE_LIMITED" };
  // The message that crossed the limit stays on the timeline as discarded; the reply answers it.
  const source = await appendInbound(deps.data, {
    wamid: message.id,
    importer,
    operationId: anchor.operationId,
    to: ctx.to,
    body: normalizeInboundText(message.text?.body ?? ""),
    simulated: ctx.simulated,
    sentAtSim: input.atSim,
    sentAtReal: input.atReal,
    status: "DISCARDED",
  });
  await reply(ctx, { key: "rateLimited", importer, operationId: anchor.operationId, source, atSim: input.atSim });
  return { wamid: message.id, outcome: "RATE_LIMITED", operationId: anchor.operationId, messageId: source.messageId };
}
