// The demo mailbox (docs/architecture-integrations.md §3, FL-084): every verified mail a simulated
// mailbox receives, the firm's own (`estudio-…`, where escalations land) and its suppliers', becomes a
// `MailboxMessage` under `Conversations/MAILBOX#<address>`. It carries the `firmId` (and world and
// operation) of the outbound message it was verified against, never one derived from the address:
// the console filters by that firm (routers/mailbox.ts). The body is plain text only: the `text/plain`
// part or the HTML as text, cleaned of control characters, with sensitive numbers masked; the console
// shows it as text, never as HTML.
import { ConnectorError } from "@legajo/shared";
import type { ParsedMail } from "../channels/email/mime";
import { emailBodyText, normalizeInboundText } from "../channels/normalizer";
import type { Connector } from "../connector/connector";
import { ZonedInstant } from "../domain/common";
import type { VerifiedMail } from "./guard";

/** `MailboxMessage.bodyText` holds at most this much (docs/architecture.md §5). */
export const MAILBOX_BODY_MAX_CHARS = 20_000;
const SUBJECT_MAX_CHARS = 998;

export interface MailboxInput {
  readonly mail: VerifiedMail;
  readonly parsed: ParsedMail;
  /** SES's id of the received mail: the stored row's id, so a redelivery writes nothing new. */
  readonly sesMessageId: string;
  /** SES's receipt timestamp (real); the sort key of the row. */
  readonly receivedAtReal: string;
  readonly receivedAtSim: string;
}

function plainSubject(subject: string): string {
  return [...subject.replace(/[\u0000-\u001f\u007f]/g, " ").trim()].slice(0, SUBJECT_MAX_CHARS).join("");
}

/** Stores the mail once; a redelivery of the same SES message finds the row already there. */
export async function storeMailboxMessage(data: Pick<Connector, "conversations">, input: MailboxInput): Promise<{ readonly stored: boolean }> {
  const { mail, parsed } = input;
  const { outbound } = mail;
  const row: Parameters<Connector["conversations"]["putMailboxMessage"]>[0] = {
    mailboxAddress: mail.recipient,
    mailboxMessageId: input.sesMessageId,
    firmId: outbound.firmId,
    operationId: outbound.operationId,
    clockId: outbound.clockId,
    from: mail.author,
    to: mail.recipient,
    subject: plainSubject(parsed.subject),
    bodyText: normalizeInboundText(emailBodyText({ text: parsed.text, html: parsed.html }), MAILBOX_BODY_MAX_CHARS).text,
    receivedAtReal: ZonedInstant.parse(input.receivedAtReal),
    receivedAtSim: input.receivedAtSim,
    sesMessageId: input.sesMessageId,
    ...(parsed.inReplyTo[0] === undefined ? {} : { inReplyTo: parsed.inReplyTo[0] }),
    references: [...parsed.references],
  };
  try {
    await data.conversations.putMailboxMessage(row);
    return { stored: true };
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") return { stored: false };
    throw error;
  }
}
