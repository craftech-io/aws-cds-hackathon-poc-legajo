// zod schemas of what End User Messaging Social publishes to SNS (docs/architecture-integrations.md
// §4.1): the Lambda's `Records[].Sns` wrapper, the EUM envelope in `Sns.Message`, and the Meta webhook
// entry it carries as a JSON string. The phone simulator builds exactly this shape (sim-envelope.ts),
// so both paths go through the same parser. Objects are loose (Meta adds fields over time) but every
// field the adapter reads is validated; `contacts[].profile.name` is never read.
import { z } from "zod";

// ---- Lambda event (SNS) --------------------------------------------------------------------------

const MessageAttribute = z.looseObject({ Type: z.string(), Value: z.string() });

export const SnsNotification = z.looseObject({
  Type: z.string().optional(),
  MessageId: z.string().min(1).max(128),
  TopicArn: z.string().min(1).max(512),
  Message: z.string().min(2).max(256_000),
  Timestamp: z.string().optional(),
  MessageAttributes: z.record(z.string(), MessageAttribute).default({}),
});
export type SnsNotification = z.infer<typeof SnsNotification>;

export const SnsRecord = z.looseObject({
  EventSource: z.string().min(1).max(64),
  EventSubscriptionArn: z.string().max(512).optional(),
  Sns: SnsNotification,
});
export type SnsRecord = z.infer<typeof SnsRecord>;

export const WhatsAppSnsEvent = z.looseObject({ Records: z.array(SnsRecord).min(1).max(100) });
export type WhatsAppSnsEvent = z.infer<typeof WhatsAppSnsEvent>;

// ---- EUM envelope (`Sns.Message`) ------------------------------------------------------------------

export const EumEnvelope = z.looseObject({
  context: z.looseObject({
    MetaWabaIds: z.array(z.looseObject({ wabaId: z.string().min(1), arn: z.string().optional() })).default([]),
    MetaPhoneNumberIds: z.array(z.looseObject({ metaPhoneNumberId: z.string().min(1), arn: z.string().optional() })).default([]),
  }),
  whatsAppWebhookEntry: z.string().min(2).max(256_000),
  aws_account_id: z.string().regex(/^\d{12}$/),
  message_timestamp: z.string().optional(),
  messageId: z.string().optional(),
});
export type EumEnvelope = z.infer<typeof EumEnvelope>;

// ---- Meta webhook entry -------------------------------------------------------------------------

/** `wa_id` / `from`: the sender's number, digits only as Meta sends it. */
const WaId = z.string().regex(/^\+?\d{8,15}$/, "expected a WhatsApp number");
/** A `wamid`: Meta's are base64 after `wamid.`, the simulator's `wamid.SIM.<id>`. */
export const Wamid = z.string().min(6).max(256).regex(/^[A-Za-z0-9._=+/-]+$/, "unexpected characters in a message id");
/** Unix seconds, as a string. */
const UnixSeconds = z.string().regex(/^\d{9,11}$/);

const MediaObject = z.looseObject({
  id: z.string().min(1).max(512),
  mime_type: z.string().max(128).optional(),
  sha256: z.string().max(128).optional(),
  caption: z.string().max(4_096).optional(),
  filename: z.string().max(512).optional(),
});
export type WaMediaObject = z.infer<typeof MediaObject>;

const Reply = z.looseObject({ id: z.string().min(1).max(256), title: z.string().max(200).default(""), description: z.string().max(200).optional() });

export const WaInboundMessage = z.looseObject({
  from: WaId,
  id: Wamid,
  timestamp: UnixSeconds,
  type: z.string().min(1).max(32),
  /** Present when the message answers one of ours (a button reply, a quoted reply). */
  context: z.looseObject({ from: z.string().optional(), id: z.string().max(256).optional() }).optional(),
  text: z.looseObject({ body: z.string().max(4_096) }).optional(),
  /** Quick reply of a template: `payload` is the nonce. */
  button: z.looseObject({ payload: z.string().max(256).default(""), text: z.string().max(200).default("") }).optional(),
  /** Reply of an interactive message: `id` is the nonce. */
  interactive: z
    .looseObject({ type: z.string().max(32), button_reply: Reply.optional(), list_reply: Reply.optional() })
    .optional(),
  document: MediaObject.optional(),
  image: MediaObject.optional(),
  audio: MediaObject.optional(),
  video: MediaObject.optional(),
  sticker: MediaObject.optional(),
});
export type WaInboundMessage = z.infer<typeof WaInboundMessage>;

export const WaStatusError = z.looseObject({
  code: z.number().int(),
  title: z.string().max(256).optional(),
  message: z.string().max(1_024).optional(),
});

export const WaStatusValue = z.enum(["sent", "delivered", "read", "failed"]);
export type WaStatusValue = z.infer<typeof WaStatusValue>;

/** One `statuses[]` item: the delivery state of one of our messages. */
export const WaStatus = z.looseObject({
  id: Wamid,
  status: WaStatusValue,
  timestamp: UnixSeconds,
  recipient_id: WaId,
  pricing: z.looseObject({ billable: z.boolean().optional(), pricing_model: z.string().optional(), category: z.string().max(64).optional() }).optional(),
  errors: z.array(WaStatusError).max(10).optional(),
});
export type WaStatus = z.infer<typeof WaStatus>;

export const WaChangeValue = z.looseObject({
  messaging_product: z.literal("whatsapp"),
  metadata: z.looseObject({ phone_number_id: z.string().min(1).max(128), display_phone_number: z.string().max(32).optional() }),
  messages: z.array(WaInboundMessage).max(100).default([]),
  // Meta adds states over time (`deleted`, `warning`, …): those items are dropped, not the whole event.
  statuses: z
    .array(z.unknown())
    .max(100)
    .default([])
    .transform((items) => items.filter((item) => WaStatusValue.safeParse((item as { status?: unknown } | null)?.status).success))
    .pipe(z.array(WaStatus)),
});
export type WaChangeValue = z.infer<typeof WaChangeValue>;

export const WaWebhookEntry = z.looseObject({
  id: z.string().min(1).max(128),
  changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })).min(1).max(50),
});
export type WaWebhookEntry = z.infer<typeof WaWebhookEntry>;

/** An envelope parsed down to what the adapter uses: the WABA, the phone ids and the `messages` changes. */
export interface ParsedEnvelope {
  readonly envelope: EumEnvelope;
  readonly entry: WaWebhookEntry;
  readonly changes: readonly WaChangeValue[];
}

export class PayloadError extends Error {
  override readonly name = "PayloadError";
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PayloadError(`${what} is not valid JSON`);
  }
}

function check<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PayloadError(`${what} has an unexpected shape at ${parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ")}`);
  return parsed.data;
}

/**
 * Parses `Sns.Message` into the EUM envelope and its webhook entry. Only `messages` changes are kept
 * (other fields, such as template status updates, are ignored); a change of that field that does not
 * validate is a PayloadError, never a silent skip.
 */
export function parseEnvelope(message: string): ParsedEnvelope {
  const envelope = check(EumEnvelope, parseJson(message, "the SNS message"), "the EUM envelope");
  const entry = check(WaWebhookEntry, parseJson(envelope.whatsAppWebhookEntry, "whatsAppWebhookEntry"), "whatsAppWebhookEntry");
  const changes = entry.changes.filter((change) => change.field === "messages").map((change, index) => check(WaChangeValue, change.value, `changes[${index}].value`));
  return { envelope, entry, changes };
}

/** E.164 of a WhatsApp number (`5491155500101` → `+5491155500101`). */
export function e164Of(waId: string): string {
  return waId.startsWith("+") ? waId : `+${waId}`;
}

/** Real instant of a Meta timestamp (unix seconds). */
export function instantOf(unixSeconds: string): string {
  return new Date(Number(unixSeconds) * 1_000).toISOString();
}
