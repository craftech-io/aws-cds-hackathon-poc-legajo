// The envelope of the phone simulator (docs/architecture-integrations.md §4.2): the BFF (and the
// `QaDriver`) build exactly the SNS record End User Messaging Social publishes, from the registered
// phone of the importer, with `metaPhoneNumberId = simulated` and a `wamid.SIM.<id>`, and sign the
// message body with the `sim-envelope` subkey. `InboundWhatsApp` refuses a simulated envelope in live
// mode and one whose signature does not verify (registry.ts).
import { type SecretKey, hmacSha256Base64Url, safeEqual, sha256Hex, ulid } from "../../lib/crypto";
import { PDF_MIME_TYPE, SIMULATED_PHONE_NUMBER_ID, SIM_EVENT_SOURCE, SIM_SIGNATURE_ATTRIBUTE, SIM_WAMID_PREFIX, STAGE_ACCOUNT_ID } from "./config";
import type { ParsedEnvelope, SnsRecord, WhatsAppSnsEvent } from "./payloads";

/** What the importer does on the simulated phone, already resolved to nonces and media keys by the caller. */
export type SimulatedContent =
  | { readonly type: "text"; readonly text: string }
  /** Quick reply of a template: the nonce travels as `payload`. */
  | { readonly type: "template_reply"; readonly nonce: string; readonly title: string }
  /** Reply button of an interactive message. */
  | { readonly type: "button_reply"; readonly nonce: string; readonly title: string }
  /** Row of an interactive list (`OPERATION_CHOICE`). */
  | { readonly type: "list_reply"; readonly nonce: string; readonly title: string }
  /** A PDF already in `Media/sim/…`: its `document.id` is `sim-media:<key>`. */
  | { readonly type: "document"; readonly mediaRef: string; readonly filename?: string; readonly caption?: string }
  /** Any other media; the adapter answers it with a fixed text and never downloads it. */
  | { readonly type: "media"; readonly mediaType: "image" | "audio" | "video" | "sticker"; readonly caption?: string };

export interface SimulatedMessageInput {
  /** Registered phone of the importer (E.164). */
  readonly from: string;
  readonly wamid: string;
  readonly content: SimulatedContent;
  /** The `wamid` of our message the importer answers (a button reply). */
  readonly contextWamid?: string;
  /** Real instant of the tap or the text. */
  readonly at: Date;
}

/** `wamid.SIM.<ULID>` for the console's simulator; the `QaDriver` derives its own from the step's key. */
export function newSimulatedWamid(nowMs: number): string {
  return `${SIM_WAMID_PREFIX}${ulid(nowMs)}`;
}

function messageOf(input: SimulatedMessageInput): Record<string, unknown> {
  const base = {
    from: input.from.replace(/^\+/, ""),
    id: input.wamid,
    timestamp: String(Math.floor(input.at.getTime() / 1_000)),
    ...(input.contextWamid === undefined ? {} : { context: { from: SIMULATED_PHONE_NUMBER_ID, id: input.contextWamid } }),
  };
  const content = input.content;
  switch (content.type) {
    case "text":
      return { ...base, type: "text", text: { body: content.text } };
    case "template_reply":
      return { ...base, type: "button", button: { payload: content.nonce, text: content.title } };
    case "button_reply":
      return { ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: content.nonce, title: content.title } } };
    case "list_reply":
      return { ...base, type: "interactive", interactive: { type: "list_reply", list_reply: { id: content.nonce, title: content.title } } };
    case "document":
      return {
        ...base,
        type: "document",
        document: { id: content.mediaRef, mime_type: PDF_MIME_TYPE, ...(content.filename === undefined ? {} : { filename: content.filename }), ...(content.caption === undefined ? {} : { caption: content.caption }) },
      };
    case "media":
      return { ...base, type: content.mediaType, [content.mediaType]: { id: `sim-${content.mediaType}`, ...(content.caption === undefined ? {} : { caption: content.caption }) } };
  }
}

/** The EUM envelope (`Sns.Message`) of one simulated message, with the same shape as a live one. */
export function simulatedEnvelopeMessage(input: SimulatedMessageInput): string {
  const entry = {
    id: SIMULATED_PHONE_NUMBER_ID,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: SIMULATED_PHONE_NUMBER_ID },
          contacts: [{ wa_id: input.from.replace(/^\+/, "") }],
          messages: [messageOf(input)],
        },
      },
    ],
  };
  return JSON.stringify({
    context: { MetaWabaIds: [], MetaPhoneNumberIds: [{ metaPhoneNumberId: SIMULATED_PHONE_NUMBER_ID }] },
    whatsAppWebhookEntry: JSON.stringify(entry),
    aws_account_id: STAGE_ACCOUNT_ID,
    message_timestamp: input.at.toISOString(),
    messageId: sha256Hex(input.wamid).slice(0, 32),
  });
}

/** HMAC-SHA256 of the SNS message body with the `sim-envelope` subkey, base64url. */
export function signSimulatedMessage(simEnvelopeKey: SecretKey, message: string): string {
  return hmacSha256Base64Url(simEnvelopeKey, message);
}

/** The Lambda event `simulator.*` hands to `InboundWhatsApp` (`Records[].Sns`). */
export function buildSimulatedEvent(simEnvelopeKey: SecretKey, input: SimulatedMessageInput): WhatsAppSnsEvent {
  const message = simulatedEnvelopeMessage(input);
  const record: SnsRecord = {
    EventSource: SIM_EVENT_SOURCE,
    EventSubscriptionArn: SIMULATED_PHONE_NUMBER_ID,
    Sns: {
      Type: "Notification",
      MessageId: sha256Hex(`sns#${input.wamid}`).slice(0, 32),
      TopicArn: SIMULATED_PHONE_NUMBER_ID,
      Message: message,
      Timestamp: input.at.toISOString(),
      MessageAttributes: { [SIM_SIGNATURE_ATTRIBUTE]: { Type: "String", Value: signSimulatedMessage(simEnvelopeKey, message) } },
    },
  };
  return { Records: [record] };
}

/** True when the record carries a signature of its body made with the `sim-envelope` subkey. */
export function hasValidSimSignature(simEnvelopeKey: SecretKey, record: SnsRecord): boolean {
  const signature = record.Sns.MessageAttributes[SIM_SIGNATURE_ATTRIBUTE]?.Value;
  return signature !== undefined && safeEqual(signature, signSimulatedMessage(simEnvelopeKey, record.Sns.Message));
}

/** Any trace of the simulator: its event source, its signature, its phone id or a simulated message id. */
export function looksSimulated(record: SnsRecord, parsed: ParsedEnvelope | undefined): boolean {
  if (record.EventSource === SIM_EVENT_SOURCE || record.Sns.MessageAttributes[SIM_SIGNATURE_ATTRIBUTE] !== undefined) return true;
  if (parsed === undefined) return false;
  if (parsed.envelope.context.MetaPhoneNumberIds.some((phone) => phone.metaPhoneNumberId === SIMULATED_PHONE_NUMBER_ID)) return true;
  return parsed.changes.some(
    (change) =>
      change.metadata.phone_number_id === SIMULATED_PHONE_NUMBER_ID ||
      change.messages.some((message) => message.id.startsWith(SIM_WAMID_PREFIX)) ||
      change.statuses.some((status) => status.id.startsWith(SIM_WAMID_PREFIX)),
  );
}
