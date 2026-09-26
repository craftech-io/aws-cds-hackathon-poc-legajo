// SES delivery events (docs/architecture-integrations.md §1, "Eventos"): the configuration set
// `…-email-<stage>` publishes them to EventBridge and a rule filtered by that set invokes
// `ChannelEvents`, which only reads `Conversations` and `Runtime` and writes the queue:
//
//   1. the EventBridge event is validated with zod;
//   2. the `Message OUT` is found by its SES message id (`Conversations GSI1`); an event of a mail we
//      did not record is dropped, one of a mail recorded a moment later is retried;
//   3. `EMAIL_EVENT` is enqueued (id derived from `<sesMessageId>#<eventType>#<recipient>`, so a
//      redelivered event is processed once) with its `ADD` in `inFlight`;
//   4. only then a `SES_EVENT` pending mail is closed: a bounce or complaint of SES's mailbox
//      simulator, or the first event of a registered demo recipient. A delivery to a `sim.` mailbox
//      closes nothing: `SimMail` does.
//
// `planEmailEvent` is what `apply_email_event` does with it in the worker: states and timers.
import { z } from "zod";
import { ChannelError, IsoInstant, SES_MAILBOX_SIMULATOR_DOMAIN, type TurnTrigger } from "@legajo/shared";
import type { ConversationsPort, WorldPort } from "../../connector/ports-runtime";
import type { Message, MessageStatus } from "../../domain/conversations";
import { sha256Hex } from "../../lib/crypto";
import { simNowOf } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import { BounceType, type ChannelEventSink, SesEventType, channelEvent, derivedEventId } from "../adapter";
import { parseReceivedAddress } from "./address";
import { type PendingDeps, closeMailPending } from "./pending";

const DETAIL_TYPES: Readonly<Record<string, SesEventType>> = {
  "Email Delivered": "DELIVERY",
  "Email Bounced": "BOUNCE",
  "Email Complaint Received": "COMPLAINT",
  "Email Rejected": "REJECT",
  "Email Delivery Delayed": "DELIVERY_DELAY",
  "Email Rendering Failed": "RENDERING_FAILURE",
};

const Recipient = z.object({ emailAddress: z.string() }).loose();

export const SesEventDetail = z
  .object({
    mail: z
      .object({
        messageId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
        destination: z.array(z.string()).default([]),
        tags: z.record(z.string(), z.array(z.string())).default({}),
      })
      .loose(),
    bounce: z.object({ bounceType: BounceType, bouncedRecipients: z.array(Recipient).default([]), timestamp: z.string().optional() }).loose().optional(),
    complaint: z.object({ complainedRecipients: z.array(Recipient).default([]), timestamp: z.string().optional() }).loose().optional(),
    delivery: z.object({ recipients: z.array(z.string()).default([]), timestamp: z.string().optional() }).loose().optional(),
    deliveryDelay: z.object({ delayedRecipients: z.array(Recipient).default([]), timestamp: z.string().optional() }).loose().optional(),
  })
  .loose();

export const SesEventBridgeEvent = z
  .object({
    source: z.literal("aws.ses"),
    "detail-type": z.string(),
    time: IsoInstant,
    detail: SesEventDetail,
  })
  .loose();

export interface SesMailEvent {
  readonly type: SesEventType;
  readonly sesMessageId: string;
  readonly bounceType?: BounceType;
  /** Recipients the event is about (bounced, complained, delivered, delayed; every destination otherwise). */
  readonly recipients: readonly string[];
  readonly occurredAtReal: string;
  readonly tags: Readonly<Record<string, readonly string[]>>;
}

/** The event of one SES delivery notification; `undefined` for a type the channel does not track (`Open`, `Click`, `Send`). */
export function parseSesEvent(event: unknown): SesMailEvent | undefined {
  const parsed = SesEventBridgeEvent.parse(event);
  const type = DETAIL_TYPES[parsed["detail-type"]];
  if (type === undefined) return undefined;
  const { detail } = parsed;
  const listed =
    type === "BOUNCE" ? detail.bounce?.bouncedRecipients.map((recipient) => recipient.emailAddress)
    : type === "COMPLAINT" ? detail.complaint?.complainedRecipients.map((recipient) => recipient.emailAddress)
    : type === "DELIVERY" ? detail.delivery?.recipients
    : type === "DELIVERY_DELAY" ? detail.deliveryDelay?.delayedRecipients.map((recipient) => recipient.emailAddress)
    : undefined;
  const recipients = listed !== undefined && listed.length > 0 ? listed : detail.mail.destination;
  const occurredAtReal = new Date(Date.parse(parsed.time)).toISOString();
  return {
    type,
    sesMessageId: detail.mail.messageId,
    recipients,
    occurredAtReal,
    tags: detail.mail.tags,
    ...(type === "BOUNCE" && detail.bounce !== undefined ? { bounceType: detail.bounce.bounceType } : {}),
  };
}

export interface ChannelEventsDeps {
  readonly conversations: Pick<ConversationsPort, "findMessageByProviderId">;
  readonly world: Pick<WorldPort, "getClock">;
  readonly pending: PendingDeps;
  readonly events: ChannelEventSink;
  readonly log: Logger;
}

export type SesEventOutcome = "ENQUEUED" | "IGNORED";

/**
 * Whether this event closes a `SES_EVENT` pending mail: for SES's mailbox simulator only the bounce or
 * the complaint it exists to produce (a complaint arrives after a delivery), for a registered demo
 * recipient the first event of any kind. Items waiting for `SimMail` or `InboundEmail` are never
 * touched here (`awaiting` is checked on close).
 */
function closesPending(type: SesEventType, recipient: string): boolean {
  const parsed = parseReceivedAddress(recipient);
  if (!parsed.ok) return false;
  return parsed.value.domain !== SES_MAILBOX_SIMULATOR_DOMAIN || type === "BOUNCE" || type === "COMPLAINT";
}

export async function processSesEvent(event: unknown, deps: ChannelEventsDeps): Promise<SesEventOutcome> {
  const mailEvent = parseSesEvent(event);
  if (mailEvent === undefined) return "IGNORED";
  const message = await deps.conversations.findMessageByProviderId(mailEvent.sesMessageId);
  if (message === undefined || message.direction !== "OUT" || message.channel !== "EMAIL") {
    // A mail we tagged but have not recorded yet: fail so EventBridge delivers the event again.
    if (mailEvent.tags.messageId !== undefined) throw new ChannelError("UNAVAILABLE", "EMAIL", "the message of this SES event is not recorded yet");
    deps.log.info("SES event of a mail that is not ours", { type: mailEvent.type });
    return "IGNORED";
  }
  const clock = await deps.world.getClock(message.clockId);
  const eventAtSim = simNowOf(clock, Date.parse(mailEvent.occurredAtReal)).toISOString();
  for (const recipient of mailEvent.recipients) {
    await deps.events.enqueue(
      channelEvent({
        type: "EMAIL_EVENT",
        eventId: derivedEventId("EMAIL_EVENT", `${mailEvent.sesMessageId}#${mailEvent.type}#${recipient.trim().toLowerCase()}`),
        operationId: message.operationId,
        clockId: message.clockId,
        firmId: message.firmId,
        eventAtSim,
        messageId: message.messageId,
        sesEventType: mailEvent.type,
        occurredAtReal: mailEvent.occurredAtReal,
        ...(mailEvent.bounceType === undefined ? {} : { bounceType: mailEvent.bounceType }),
      }),
    );
    if (message.mailId !== undefined && closesPending(mailEvent.type, recipient)) {
      await closeMailPending(deps.pending, { clockId: message.clockId, mailId: message.mailId, from: message.from, outcome: "SES_EVENT", reason: mailEvent.type, operationId: message.operationId, awaiting: "SES_EVENT" });
    }
  }
  return "ENQUEUED";
}

// ---- What `apply_email_event` does with an `EMAIL_EVENT` ---------------------------------------

const HOUR_MS = 60 * 60 * 1000;
/** `TIMER#CONTACT_CHECK` one simulated day after a permanent bounce. */
export const CONTACT_CHECK_DELAY_MS = 24 * HOUR_MS;
/** `TIMER#BOUNCE_RETRY` four simulated hours after a transient bounce (one retry per message). */
export const BOUNCE_RETRY_DELAY_MS = 4 * HOUR_MS;

const FINAL_STATUSES: ReadonlySet<MessageStatus> = new Set<MessageStatus>(["BOUNCED", "COMPLAINED", "FAILED"]);

export interface EmailEventPlanInput {
  readonly type: SesEventType;
  readonly bounceType?: BounceType | undefined;
  readonly message: Pick<Message, "messageId" | "status" | "contactId">;
  /** Simulated instant the worker applies the event at. */
  readonly atSim: string;
}

export interface EmailEventPlan {
  /** New status of the `Message OUT`; absent when it already reached a final one. */
  readonly messageStatus?: MessageStatus;
  readonly contactStatus?: "BOUNCED" | "COMPLAINED";
  readonly timer?: { readonly kind: "CONTACT_CHECK" | "BOUNCE_RETRY"; readonly timerId: string; readonly dueAtSim: string };
  readonly turn?: Extract<TurnTrigger, "EMAIL_BOUNCED">;
  readonly escalation?: "NO_VALID_CONTACT";
  /** Rejections and rendering failures raise the error alarm. */
  readonly alarm: boolean;
}

/** `contact-check-<16 hex>` / `bounce-retry-<16 hex>`: one timer per contact (check) or message (retry). */
function timerIdOf(prefix: string, key: string): string {
  return `${prefix}-${sha256Hex(key).slice(0, 16)}`;
}

function later(atSim: string, ms: number): string {
  return new Date(Date.parse(atSim) + ms).toISOString();
}

export function planEmailEvent(input: EmailEventPlanInput): EmailEventPlan {
  const status = (next: MessageStatus): { messageStatus?: MessageStatus } => (FINAL_STATUSES.has(input.message.status) ? {} : { messageStatus: next });
  switch (input.type) {
    case "DELIVERY":
      return { ...status("DELIVERED"), alarm: false };
    case "DELIVERY_DELAY":
      return { ...status("DELAYED"), alarm: false };
    case "COMPLAINT":
      return { ...status("COMPLAINED"), contactStatus: "COMPLAINED", escalation: "NO_VALID_CONTACT", alarm: false };
    case "REJECT":
    case "RENDERING_FAILURE":
      return { ...status("FAILED"), alarm: true };
    case "BOUNCE": {
      if (input.bounceType === "Permanent") {
        const key = input.message.contactId ?? input.message.messageId;
        return {
          ...status("BOUNCED"),
          contactStatus: "BOUNCED",
          turn: "EMAIL_BOUNCED",
          timer: { kind: "CONTACT_CHECK", timerId: timerIdOf("contact-check", key), dueAtSim: later(input.atSim, CONTACT_CHECK_DELAY_MS) },
          alarm: false,
        };
      }
      return {
        ...status("DELAYED"),
        timer: { kind: "BOUNCE_RETRY", timerId: timerIdOf("bounce-retry", input.message.messageId), dueAtSim: later(input.atSim, BOUNCE_RETRY_DELAY_MS) },
        alarm: false,
      };
    }
  }
}
