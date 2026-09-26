// `InboundEmail` (docs/architecture-integrations.md §2): a mail to an operation's thread address, as
// the receipt rule `ops-<stage>` delivers it. The Lambda entry (handlers/inbound-email.ts) only wires
// the ports; the mandatory order lives here:
//
//   1. idempotency by SES's message id and by the MIME `Message-ID` (`Runtime/IDEMP#EMAIL#…`);
//   2. the recipient: exactly one thread address that resolves to a live operation, or a discard
//      before any other work, counted in `ThreadAddressInvalid` without an audit row;
//   3. spam and virus verdicts (`PASS` or an audited discard); trust is `dmarcVerdict PASS` alone, for
//      a mail with one unambiguous author on which SES and the MIME agree (`senderOf`, `singleAuthor`);
//   4-9. automatic replies, sender, normalization, attachments, thread and events (inbound-record.ts);
//   10. if the mail is ours (DMARC, our domains, a valid `X-Legajo-Mail-Id` with an open pending item of
//       the same `From`), `PROBE#MAIL#<mailId>` with the outcome and the pending item closed, after
//       the effect was recorded.
import type { Connector } from "../../connector/connector";
import type { Idempotency } from "../../domain/runtime";
import { simNowOf } from "../../lib/clock";
import { sha256Hex } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import { type ChannelEventSink, countMetric } from "../adapter";
import { namesOnly, parseMessageIds, singleAuthor } from "./address";
import { EMAIL_IDEMPOTENCY_SOURCE, EMAIL_METRICS, INBOUND_REASONS } from "./config";
import { type RecordedOutcome, recordInboundMail } from "./inbound-record";
import { parseMime } from "./mime";
import { MAIL_ID_HEADER, closeMailPending, ownMailRef } from "./pending";
import { type ReceivedMail, eventHeader, parseReceiptEvent } from "./receipt";
import type { MailStore } from "./store";
import { type ThreadResolution, resolveThread } from "./thread";

export interface InboundEmailDeps {
  readonly data: Pick<Connector, "operations" | "parties" | "conversations" | "runtime" | "world" | "audit">;
  readonly store: MailStore;
  readonly events: ChannelEventSink;
  /** HKDF `thread` subkey (lib/secrets.ts `subkey("thread")`). */
  readonly threadKey: Uint8Array;
  /** Real clock; the simulated one comes from the operation's world (`Runtime/CLOCK#`). */
  readonly now: () => Date;
  readonly log: Logger;
}

export type InboundOutcome = RecordedOutcome | "DISCARDED" | "DUPLICATE";

export interface InboundEmailResult {
  readonly outcome: InboundOutcome;
  readonly reason?: string;
  readonly operationId?: string;
  readonly messageId?: string;
}

/**
 * Idempotency ids of a received mail: SES's id, and the MIME `Message-ID` hashed together with the
 * recipients, the sender and the DMARC verdict. A redelivery repeats all four; a forged mail that
 * reuses someone's `Message-ID` from another sender, or without passing DMARC, can never make the
 * genuine one look like a duplicate.
 */
function idempotencyIds(received: ReceivedMail): string[] {
  const ids = [`ses:${received.mail.messageId}`];
  const rfcId = parseMessageIds(received.mail.commonHeaders.messageId)[0];
  if (rfcId !== undefined) {
    const scope = [received.receipt.recipients.map((recipient) => recipient.trim().toLowerCase()).sort().join(","), senderOf(received) ?? "", received.receipt.dmarcVerdict.status, rfcId];
    ids.push(`mid:${sha256Hex(scope.join("|"))}`);
  }
  return ids;
}

const DISCARD_REASONS: Readonly<Record<Exclude<ThreadResolution["status"], "RESOLVED">, string>> = {
  INVALID: INBOUND_REASONS.threadAddressInvalid,
  NOT_THREAD: INBOUND_REASONS.threadAddressInvalid,
  UNKNOWN: INBOUND_REASONS.threadAddressUnknown,
  TOMBSTONED: INBOUND_REASONS.tombstoned,
};

/**
 * The one author of the mail as SES saw it: a single `From` among the event's headers holding a single
 * mailbox, which `commonHeaders.from` names alone. `undefined` when there is none, several, or the
 * headers were truncated: such a mail is never ours and never trusted.
 */
function senderOf(received: ReceivedMail): string | undefined {
  const { mail } = received;
  if (mail.headersTruncated) return undefined;
  const author = singleAuthor(eventHeader(mail, "from"));
  return author !== undefined && namesOnly(mail.commonHeaders.from ?? [], author) ? author : undefined;
}

export async function receiveInboundEmail(event: unknown, deps: InboundEmailDeps): Promise<InboundEmailResult> {
  const received = parseReceiptEvent(event);
  const { mail, receipt } = received;
  const log = deps.log.child({ channel: "EMAIL", sesMessageId: mail.messageId });
  const realNow = deps.now().toISOString();
  const pendingDeps = { world: deps.data.world, runtime: deps.data.runtime, now: deps.now };

  // 1. Idempotency.
  const ids = idempotencyIds(received);
  for (const id of ids) {
    const seen = await deps.data.runtime.getIdempotency(EMAIL_IDEMPOTENCY_SOURCE, id);
    if (seen !== undefined) return duplicate(deps, seen, log);
  }

  // 2. Recipient, before any other work.
  const sesAuthor = senderOf(received);
  let own = ownMailRef({ dmarcVerdict: receipt.dmarcVerdict.status, from: sesAuthor, mailIdHeader: eventHeader(mail, MAIL_ID_HEADER)[0] });
  const recipients = receipt.recipients.map((recipient) => recipient.trim().toLowerCase());
  const resolution: ThreadResolution =
    recipients.length === 1 && recipients[0] !== undefined
      ? await resolveThread({ operations: deps.data.operations, world: deps.data.world, threadKey: deps.threadKey, now: deps.now }, recipients[0])
      : { status: "NOT_THREAD" };
  if (resolution.status !== "RESOLVED") {
    const reason = DISCARD_REASONS[resolution.status];
    countMetric(log, EMAIL_METRICS.threadAddressInvalid, { reason });
    if (own !== undefined) await closeMailPending(pendingDeps, { ...own, outcome: "DISCARDED", reason });
    return { outcome: "DISCARDED", reason };
  }
  const { operation } = resolution;
  const close = async (outcome: Parameters<typeof closeMailPending>[1]["outcome"], reason?: string): Promise<void> => {
    if (own !== undefined) await closeMailPending(pendingDeps, { ...own, outcome, operationId: operation.operationId, ...(reason === undefined ? {} : { reason }) });
  };
  const claim = async (result: Record<string, unknown>): Promise<void> => {
    for (const id of ids) await deps.data.runtime.claimIdempotency({ source: EMAIL_IDEMPOTENCY_SOURCE, id, atReal: realNow, result: { ...result, operationId: operation.operationId, firmId: operation.firmId, clockId: operation.clockId } });
  };
  const simNow = simNowOf(await deps.data.world.getClock(operation.clockId), deps.now().getTime()).toISOString();

  // 3. Spam and virus: an audited discard.
  const failed = receipt.spamVerdict.status !== "PASS" ? INBOUND_REASONS.spamVerdict : receipt.virusVerdict.status !== "PASS" ? INBOUND_REASONS.virusVerdict : undefined;
  if (failed !== undefined) {
    await deps.data.audit.record({
      firmId: operation.firmId,
      decision: "DENY",
      action: "EMAIL_DISCARDED",
      actor: "SYSTEM",
      reason: failed,
      refs: { operationId: operation.operationId },
      clockId: operation.clockId,
      operationId: operation.operationId,
      atSim: simNow,
      atReal: realNow,
      correlationId: log.correlationId,
    });
    await close("DISCARDED", failed);
    await claim({ outcome: "DISCARDED", reason: failed });
    return { outcome: "DISCARDED", reason: failed, operationId: operation.operationId };
  }

  // 4-9. The raw MIME, then everything the message becomes.
  const rawKey = deps.store.rawKey(mail.messageId);
  const parsed = await parseMime(await deps.store.readRaw(mail.messageId));
  // Ours only if the MIME names the same single author SES did.
  if (own !== undefined && parsed.from !== own.from) own = undefined;
  const recorded = await recordInboundMail(
    { data: deps.data, store: deps.store, events: deps.events, log },
    { operation, mail: parsed, sesMessageId: mail.messageId, rawKey, dmarcPass: receipt.dmarcVerdict.status === "PASS", ...(sesAuthor === undefined ? {} : { sesAuthor }), simNow, realNow, correlationId: log.correlationId },
  );

  // 10. The pending mail closes only after its effect is on record.
  await close(recorded.outcome, recorded.reason);
  await claim({ outcome: recorded.outcome, messageId: recorded.messageId });
  return { outcome: recorded.outcome, operationId: operation.operationId, messageId: recorded.messageId, ...(recorded.reason === undefined ? {} : { reason: recorded.reason }) };
}

/** A redelivery: recorded once in the audit log of the operation it went to, never processed again. */
async function duplicate(deps: InboundEmailDeps, seen: Idempotency, log: Logger): Promise<InboundEmailResult> {
  const result = seen.result ?? {};
  const operationId = typeof result.operationId === "string" ? result.operationId : undefined;
  const firmId = typeof result.firmId === "string" ? result.firmId : undefined;
  const messageId = typeof result.messageId === "string" ? result.messageId : undefined;
  log.info("duplicate inbound email ignored", { operationId, messageId });
  if (operationId !== undefined && firmId !== undefined) {
    await deps.data.audit.record({
      firmId,
      decision: "ACTION",
      action: "EMAIL_DUPLICATE_IGNORED",
      actor: "SYSTEM",
      refs: { operationId, ...(messageId === undefined ? {} : { messageId }) },
      operationId,
      ...(typeof result.clockId === "string" ? { clockId: result.clockId } : {}),
      atReal: deps.now().toISOString(),
      correlationId: log.correlationId,
    });
  }
  return { outcome: "DUPLICATE", ...(operationId === undefined ? {} : { operationId }), ...(messageId === undefined ? {} : { messageId }) };
}
