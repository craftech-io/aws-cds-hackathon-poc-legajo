// SES between the parties of a local world. What the single SES client sent (the fake records each
// `SendEmail` with its `MessageId`) is turned into the raw MIME SES would deliver and the receipt event
// of the rule that catches it: `sim-poc` (SimMail, our mail to a simulated supplier or the firm's
// mailbox) or `ops-poc` (InboundEmail, a supplier's reply to an operation's thread address). The MIME
// carries what SES adds: `Message-ID: <MessageId@email.amazonses.com>`, our `X-Legajo-*` headers and
// the attachments; the verdicts are SES's for a mail it signed itself (all `PASS`).
import { SES_MESSAGE_ID_DOMAIN } from "@legajo/bff/channels/email/address";
import type { ObjectStore } from "../fakes/objects";
import type { SentEmail } from "../fakes/aws";
import { LOCAL_BUCKETS, MAIL_ROUTES } from "./context";

export const SIM_DOMAIN = "sim.legajo.demo.craftech.io";
export const OPS_DOMAIN = "legajo.demo.craftech.io";

export type MailRoute = "sim" | "ops" | "outside";

/** Where a recipient's mail lands: the `sim-poc` rule, the `ops-poc` rule, or nowhere in this world. */
export function routeOf(recipient: string): MailRoute {
  const domain = recipient.trim().toLowerCase().split("@")[1] ?? "";
  if (domain === SIM_DOMAIN) return "sim";
  if (domain === OPS_DOMAIN) return "ops";
  return "outside";
}

/** `<id@email.amazonses.com>`: the `Message-ID` SES gives a mail it sent. */
export function rfcMessageIdOf(sesMessageId: string): string {
  return `<${sesMessageId}@${SES_MESSAGE_ID_DOMAIN}>`;
}

function base64Lines(bytes: Uint8Array): string[] {
  return (Buffer.from(bytes).toString("base64").match(/.{1,76}/g) ?? []) as string[];
}

function textPart(contentType: string, text: string): string[] {
  return [`Content-Type: ${contentType}; charset="utf-8"`, "Content-Transfer-Encoding: base64", "", ...base64Lines(new TextEncoder().encode(text))];
}

/** The raw MIME SES builds from a `Content.Simple` request. */
export function mimeOf(sent: SentEmail): Uint8Array {
  const { input, messageId } = sent;
  const simple = input.Content?.Simple;
  if (simple === undefined) throw new Error("the local mailroom only delivers Content.Simple mail");
  const boundary = `=_legajo_local_${messageId}`;
  const to = input.Destination?.ToAddresses ?? [];
  const headers = (simple.Headers ?? []).map((header) => `${header.Name ?? ""}: ${header.Value ?? ""}`);
  const parts: string[] = [];
  const text = simple.Body?.Text?.Data;
  const html = simple.Body?.Html?.Data;
  const alternative = `${boundary}_alt`;
  // The body is one multipart/alternative (text and HTML of the same words), as SES builds it.
  const bodies = [...(text === undefined ? [] : [textPart("text/plain", text)]), ...(html === undefined ? [] : [textPart("text/html", html)])];
  if (bodies.length > 0) parts.push(`--${boundary}`, `Content-Type: multipart/alternative; boundary="${alternative}"`, "", ...bodies.flatMap((body) => [`--${alternative}`, ...body]), `--${alternative}--`);
  for (const file of simple.Attachments ?? []) {
    const name = file.FileName ?? "attachment.pdf";
    parts.push(`--${boundary}`, `Content-Type: ${file.ContentType ?? "application/pdf"}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", ...base64Lines(file.RawContent ?? new Uint8Array()));
  }
  const lines = [
    `From: ${input.FromEmailAddress ?? ""}`,
    `To: ${to.join(", ")}`,
    `Subject: ${simple.Subject?.Data ?? ""}`,
    `Message-ID: ${rfcMessageIdOf(messageId)}`,
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts,
    `--${boundary}--`,
    "",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}

export type Verdict = "spamVerdict" | "virusVerdict" | "spfVerdict" | "dkimVerdict" | "dmarcVerdict";

/** The SES receipt event of one recipient (the shape `parseReceiptEvent` validates). */
export function receiptOf(input: { readonly sent: SentEmail; readonly sesMessageId: string; readonly recipient: string; readonly at: Date; readonly verdicts?: Partial<Record<Verdict, string>> }): unknown {
  const { sent } = input;
  const from = sent.input.FromEmailAddress ?? "";
  const subject = sent.input.Content?.Simple?.Subject?.Data ?? "";
  const rfcMessageId = rfcMessageIdOf(sent.messageId);
  const own = (sent.input.Content?.Simple?.Headers ?? []).map((header) => ({ name: header.Name ?? "", value: header.Value ?? "" }));
  const timestamp = input.at.toISOString();
  const verdict = (name: Verdict) => ({ status: input.verdicts?.[name] ?? "PASS" });
  return {
    Records: [
      {
        eventSource: "aws:ses",
        eventVersion: "1.0",
        ses: {
          mail: {
            timestamp,
            source: from.replace(/^.*<([^<>]+)>$/, "$1"),
            messageId: input.sesMessageId,
            destination: [input.recipient],
            headersTruncated: false,
            headers: [{ name: "From", value: from }, { name: "To", value: input.recipient }, { name: "Subject", value: subject }, { name: "Message-ID", value: rfcMessageId }, ...own],
            commonHeaders: { from: [from], to: [input.recipient], messageId: rfcMessageId, subject },
          },
          receipt: {
            timestamp,
            processingTimeMillis: 100,
            recipients: [input.recipient],
            spamVerdict: verdict("spamVerdict"),
            virusVerdict: verdict("virusVerdict"),
            spfVerdict: verdict("spfVerdict"),
            dkimVerdict: verdict("dkimVerdict"),
            dmarcVerdict: verdict("dmarcVerdict"),
            action: { type: "Lambda", functionArn: "arn:aws:lambda:us-east-1:000000000000:function:legajo-local", invocationType: "Event" },
          },
        },
      },
    ],
  };
}

export interface Delivery {
  readonly route: Exclude<MailRoute, "outside">;
  readonly recipient: string;
  readonly event: unknown;
}

/**
 * Stores the MIME of one sent mail under its rule's prefix and builds one receipt event per recipient
 * that lands in this world (SES runs the rule once per recipient domain; ours has one recipient each).
 */
export function deliveriesOf(sent: SentEmail, objects: ObjectStore, inboundIdOf: (recipient: string) => string, at: Date): Delivery[] {
  const recipients = sent.input.Destination?.ToAddresses ?? [];
  const deliveries: Delivery[] = [];
  for (const recipient of recipients) {
    const route = routeOf(recipient);
    if (route === "outside") continue;
    const sesMessageId = inboundIdOf(recipient);
    objects.put({ bucket: LOCAL_BUCKETS.mail, key: `${MAIL_ROUTES[route]}${sesMessageId}`, body: mimeOf(sent), contentType: "message/rfc822" });
    const event = receiptOf({ sent, sesMessageId, recipient, at });
    deliveries.push({ route, recipient, event });
  }
  return deliveries;
}

export type SesEventType = "Bounce" | "Complaint" | "Delivery";

const DETAIL_TYPES: Readonly<Record<SesEventType, string>> = { Bounce: "Email Bounced", Complaint: "Email Complaint Received", Delivery: "Email Delivered" };

/** The event SES publishes for one sent mail through its configuration set (EventBridge to `ChannelEvents`). */
export function sesEventOf(sent: SentEmail, type: SesEventType, at: Date): unknown {
  const destination = sent.input.Destination?.ToAddresses ?? [];
  const tags = Object.fromEntries((sent.input.EmailTags ?? []).map((tag) => [tag.Name ?? "", [tag.Value ?? ""]]));
  const timestamp = at.toISOString();
  const recipients = destination.map((emailAddress) => ({ emailAddress }));
  return {
    version: "0",
    id: `ses-event-${sent.messageId}-${type.toLowerCase()}`,
    "detail-type": DETAIL_TYPES[type],
    source: "aws.ses",
    account: "000000000000",
    time: timestamp.replace(/\.\d{3}Z$/, "Z"),
    region: "us-east-1",
    resources: [],
    detail: {
      eventType: type,
      mail: { timestamp, source: sent.input.FromEmailAddress ?? "", messageId: sent.messageId, destination, headersTruncated: false, tags },
      ...(type === "Bounce" ? { bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: recipients, timestamp } } : {}),
      ...(type === "Complaint" ? { complaint: { complainedRecipients: recipients, timestamp } } : {}),
      ...(type === "Delivery" ? { delivery: { recipients: destination, timestamp } } : {}),
    },
  };
}
