// Steps 4-9 of `InboundEmail` (docs/architecture-integrations.md §2) for a mail whose address already
// resolved to a live operation and whose spam and virus verdicts passed: automatic replies, the
// sender's identity, normalization, attachments, the thread and the events. channels/email/inbound.ts
// runs steps 1-3 and 10 around it.
//
// Trust is `dmarcVerdict PASS` **and** a `From` that is an ACTIVE contact of **this** operation's
// supplier; nothing else (not DKIM, not a `d=` read from a header, not a contact found elsewhere).
import { STAGE_DOMAIN, documentsKeys, parseClockId, worldKey } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import type { MessageAttachment, Message } from "../../domain/conversations";
import type { Operation } from "../../domain/operations";
import type { SupplierContact } from "../../domain/parties";
import { sha256Hex } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import { type ChannelEventSink, type EventId, channelEvent, derivedEventId, turnEventId } from "../adapter";
import { type NormalizedText, normalizeEmailBody, normalizeInboundText } from "../normalizer";
import { parseReceivedAddress, sesMessageIdOf } from "./address";
import { INBOUND_REASONS } from "./config";
import { isAutoSubmitted } from "./headers";
import { type ParsedMail, type ScreenedAttachment, screenAttachments } from "./mime";
import type { MailStore } from "./store";

export type RecordedOutcome = "ENQUEUED" | "QUARANTINED" | "AUTO_REPLY_IGNORED";

export interface RecordDeps {
  readonly data: Pick<Connector, "parties" | "conversations" | "audit">;
  readonly store: MailStore;
  readonly events: ChannelEventSink;
  readonly log: Logger;
}

export interface RecordInput {
  readonly operation: Operation;
  readonly mail: ParsedMail;
  /** SES's id of the received mail; the stored message id derives from it. */
  readonly sesMessageId: string;
  /** Key of the raw MIME in the inbound mail bucket, where the intake reads each PDF again. */
  readonly rawKey: string;
  readonly dmarcPass: boolean;
  readonly simNow: string;
  readonly realNow: string;
  readonly correlationId: string;
}

export interface Recorded {
  readonly outcome: RecordedOutcome;
  readonly reason?: string;
  readonly messageId: string;
  readonly trusted: boolean;
  readonly eventIds: readonly EventId[];
}

const AUTOMATIC_SENDERS = /^(?:mailer-daemon|postmaster|no-?reply|noreply)(?:[+.-].*)?$/;

/** Step 4: loops and automatic mail never produce a turn. */
export function isAutomaticMail(mail: ParsedMail, from: string | undefined): boolean {
  if (isAutoSubmitted(mail.header("auto-submitted"))) return true;
  if (mail.header("precedence").some((value) => /^\s*(?:bulk|list|junk)\s*$/i.test(value))) return true;
  if (mail.header("x-autoreply").length > 0 || mail.header("x-autorespond").length > 0) return true;
  const sender = from === undefined ? undefined : parseReceivedAddress(from);
  if (sender?.ok !== true) return false;
  return AUTOMATIC_SENDERS.test(sender.value.local) || sender.value.domain === STAGE_DOMAIN;
}

/** `msg-<24 hex>` from SES's id of the received mail: a redelivery of the same mail finds the same row. */
export function inboundMessageId(sesMessageId: string): string {
  return `msg-${sha256Hex(`EMAIL#${sesMessageId}`).slice(0, 24)}`;
}

function quarantineKey(operation: Operation, messageId: string, index: number): string {
  const qaRun = parseClockId(operation.clockId)?.scope === "QA" ? operation.runId : undefined;
  return worldKey(documentsKeys.quarantine(operation.operationId, messageId, index), qaRun);
}

function attachmentRecord(screened: ScreenedAttachment, status: MessageAttachment["status"], extra: Partial<MessageAttachment> = {}): MessageAttachment {
  const { attachment } = screened;
  const filename = attachment.filename === undefined ? undefined : normalizeInboundText(attachment.filename, 255).text;
  return {
    index: attachment.index,
    contentType: attachment.contentType.slice(0, 128),
    sizeBytes: attachment.bytes.byteLength,
    status,
    ...(filename === undefined || filename === "" ? {} : { filename }),
    ...(screened.status === "REJECTED" ? { reason: screened.reason } : {}),
    ...extra,
  };
}

/** A `From` that could not be parsed is still shown in quarantine, cleaned and bounded. */
function senderText(raw: string | undefined): string {
  const text = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 320);
  return text === "" ? "unknown-sender" : text;
}

/** Step 8: the outbound message of this operation that the mail answers (never another operation's). */
async function answeredMessage(deps: RecordDeps, operation: Operation, mail: ParsedMail): Promise<Message | undefined> {
  for (const rfcId of [...mail.inReplyTo, ...[...mail.references].reverse()]) {
    const sesId = sesMessageIdOf(rfcId);
    if (sesId === undefined) continue;
    const message = await deps.data.conversations.findMessageByProviderId(sesId);
    if (message?.direction === "OUT" && message.operationId === operation.operationId) return message;
  }
  return undefined;
}

async function storeMessage(deps: RecordDeps, input: RecordInput, fields: { status: Message["status"]; trusted: boolean; contact?: SupplierContact; body: NormalizedText; attachments: MessageAttachment[] }): Promise<Message> {
  const messageId = inboundMessageId(input.sesMessageId);
  const existing = await deps.data.conversations.getMessage(input.operation.operationId, messageId);
  if (existing !== undefined) return existing;
  const from = input.mail.from === undefined ? undefined : parseReceivedAddress(input.mail.from);
  const subject = normalizeInboundText(input.mail.subject, 998).text;
  return deps.data.conversations.appendMessage({
    messageId,
    operationId: input.operation.operationId,
    firmId: input.operation.firmId,
    clockId: input.operation.clockId,
    direction: "IN",
    channel: "EMAIL",
    counterpart: "SUPPLIER",
    to: input.operation.threadAddress,
    from: from?.ok === true ? from.value.address : senderText(input.mail.from),
    body: fields.body.text,
    status: fields.status,
    author: "SUPPLIER",
    trusted: fields.trusted,
    sentAtSim: input.simNow,
    sentAtReal: input.realNow,
    providerMessageId: input.sesMessageId,
    references: [...input.mail.references],
    attachments: fields.attachments,
    truncated: fields.body.truncated,
    ...(subject === "" ? {} : { subject }),
    ...(fields.contact === undefined ? {} : { contactId: fields.contact.contactId }),
    ...(input.mail.messageId === undefined ? {} : { rfcMessageId: input.mail.messageId }),
    ...(input.mail.inReplyTo[0] === undefined ? {} : { inReplyTo: input.mail.inReplyTo[0] }),
  });
}

function eventBase(input: RecordInput) {
  return { operationId: input.operation.operationId, clockId: input.operation.clockId, firmId: input.operation.firmId, eventAtSim: input.simNow, correlationId: input.correlationId };
}

async function audit(deps: RecordDeps, input: RecordInput, entry: { decision: "ACTION" | "DENY"; action: string; messageId: string; reason?: string; detail?: Record<string, unknown>; contactId?: string }): Promise<void> {
  await deps.data.audit.record({
    firmId: input.operation.firmId,
    decision: entry.decision,
    action: entry.action,
    actor: "SYSTEM",
    messageId: entry.messageId,
    refs: { operationId: input.operation.operationId, messageId: entry.messageId, ...(entry.contactId === undefined ? {} : { contactId: entry.contactId }) },
    clockId: input.operation.clockId,
    operationId: input.operation.operationId,
    atSim: input.simNow,
    atReal: input.realNow,
    correlationId: input.correlationId,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  });
}

export async function recordInboundMail(deps: RecordDeps, input: RecordInput): Promise<Recorded> {
  const { operation, mail } = input;
  const screened = screenAttachments(mail.attachments);
  const body = normalizeEmailBody({ text: mail.text, html: mail.html });
  const contacts = await deps.data.parties.listContacts(operation.supplierId);
  const from = mail.from === undefined ? undefined : parseReceivedAddress(mail.from);
  const contact = from?.ok === true ? contacts.find((candidate) => candidate.email === from.value.address) : undefined;
  const trusted = input.dmarcPass && contact?.status === "ACTIVE";

  if (isAutomaticMail(mail, mail.from)) {
    const attachments = screened.map((entry) => attachmentRecord(entry, "REJECTED", { reason: INBOUND_REASONS.autoReply }));
    const message = await storeMessage(deps, input, { status: "DISCARDED", trusted, body, attachments, ...(contact === undefined ? {} : { contact }) });
    await audit(deps, input, { decision: "ACTION", action: INBOUND_REASONS.autoReply, messageId: message.messageId });
    return { outcome: "AUTO_REPLY_IGNORED", reason: INBOUND_REASONS.autoReply, messageId: message.messageId, trusted, eventIds: [] };
  }

  const messageId = inboundMessageId(input.sesMessageId);
  const naturalKey = mail.messageId ?? `ses:${input.sesMessageId}`;

  if (!trusted) {
    const attachments: MessageAttachment[] = [];
    for (const entry of screened) {
      if (entry.status !== "ACCEPTED") {
        attachments.push(attachmentRecord(entry, "REJECTED"));
        continue;
      }
      const key = quarantineKey(operation, messageId, entry.attachment.index);
      await deps.store.putQuarantine(key, entry.attachment.bytes);
      attachments.push(attachmentRecord(entry, "QUARANTINED", { s3Key: key }));
    }
    const message = await storeMessage(deps, input, { status: "QUARANTINED", trusted: false, body, attachments, ...(contact === undefined ? {} : { contact }) });
    await audit(deps, input, {
      decision: "DENY",
      action: INBOUND_REASONS.untrustedSender,
      messageId: message.messageId,
      reason: input.dmarcPass ? "sender is not an ACTIVE contact of the operation's supplier" : "dmarcVerdict is not PASS",
      detail: { dmarcPass: input.dmarcPass, contactStatus: contact?.status ?? "NONE" },
      ...(contact === undefined ? {} : { contactId: contact.contactId }),
    });
    const escalation = channelEvent({ type: "ESCALATE", eventId: derivedEventId("ESCALATE", naturalKey), ...eventBase(input), reason: "UNTRUSTED_SENDER", messageId: message.messageId, ...(contact === undefined ? {} : { contactId: contact.contactId }) });
    await deps.events.enqueue(escalation);
    return { outcome: "QUARANTINED", reason: INBOUND_REASONS.untrustedSender, messageId: message.messageId, trusted: false, eventIds: [escalation.eventId] };
  }

  const accepted = screened.filter((entry): entry is Extract<ScreenedAttachment, { status: "ACCEPTED" }> => entry.status === "ACCEPTED");
  const attachments = screened.map((entry) => attachmentRecord(entry, entry.status));
  const message = await storeMessage(deps, input, { status: "RECEIVED", trusted: true, body, attachments, ...(contact === undefined ? {} : { contact }) });
  if (body.truncated) await audit(deps, input, { decision: "ACTION", action: "INBOUND_TRUNCATED", messageId: message.messageId, detail: { originalChars: body.originalChars } });
  const answered = await answeredMessage(deps, operation, mail);

  const intakeIds: EventId[] = [];
  for (const entry of accepted) {
    const intake = channelEvent({
      type: "INTAKE_DOCUMENT",
      eventId: derivedEventId("INTAKE_DOCUMENT", `${naturalKey}#${entry.attachment.index}`),
      ...eventBase(input),
      source: { party: "SUPPLIER", channel: "EMAIL", messageId: message.messageId, ...(contact === undefined ? {} : { contactId: contact.contactId }) },
      object: { store: "INBOUND_MAIL", key: input.rawKey, attachmentIndex: entry.attachment.index },
      sha256: entry.sha256,
      sizeBytes: entry.attachment.bytes.byteLength,
    });
    await deps.events.enqueue(intake);
    intakeIds.push(intake.eventId);
  }
  const turn = channelEvent({
    type: "AGENT_TURN",
    eventId: turnEventId("SUPPLIER_EMAIL", naturalKey),
    ...eventBase(input),
    trigger: "SUPPLIER_EMAIL",
    messageId: message.messageId,
    intakeEventIds: intakeIds,
    ...(answered === undefined ? {} : { inReplyToMessageId: answered.messageId }),
  });
  await deps.events.enqueue(turn);
  deps.log.info("inbound email enqueued", { operationId: operation.operationId, messageId: message.messageId, intakes: intakeIds.length });
  return { outcome: "ENQUEUED", messageId: message.messageId, trusted: true, eventIds: [...intakeIds, turn.eventId] };
}
