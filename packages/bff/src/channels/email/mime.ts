// The raw MIME of a received email (the object SES's receipt rule wrote to the inbound mail bucket),
// parsed with postal-mime, and the screening of its attachments (docs/architecture-integrations.md §2,
// step 7): only `application/pdf` whose bytes really start with `%PDF-`, at most 10 MB each and at
// most 5 per message go to intake; everything else is recorded as rejected with its reason and never
// stored. The PDF itself is never interpreted here (ADR-0003): type, magic bytes, size and a SHA-256.
import PostalMime, { type Attachment, type Email } from "postal-mime";
import { ChannelError } from "@legajo/shared";
import { sha256Hex } from "../../lib/crypto";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_RAW_MAIL_BYTES, PDF_CONTENT_TYPE } from "./config";
import { parseMessageIds, singleAuthor } from "./address";

export interface MailAttachment {
  /** Position among the parsed attachments; the intake re-reads the same MIME by this index. */
  readonly index: number;
  /** Kept on the record only; never reaches the model nor becomes an object key. */
  readonly filename: string | undefined;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface ParsedMail {
  readonly messageId: string | undefined;
  readonly subject: string;
  /**
   * The one author (`singleAuthor` of address.ts): exactly one `From` header with exactly one mailbox,
   * strictly parsed and lower-cased; `undefined` for none, several or one that does not parse. The raw
   * values stay in `header("from")`.
   */
  readonly from: string | undefined;
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly attachments: readonly MailAttachment[];
  /** Every value of a header, by lower-case name. */
  header(name: string): readonly string[];
}

function bytesOf(content: Attachment["content"]): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export async function parseMime(raw: Uint8Array): Promise<ParsedMail> {
  if (raw.byteLength > MAX_RAW_MAIL_BYTES) throw new ChannelError("INVALID", "EMAIL", `raw mail larger than ${MAX_RAW_MAIL_BYTES} bytes`);
  let email: Email;
  try {
    email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer", maxNestingDepth: 32, rfc822Attachments: true });
  } catch (error) {
    throw new ChannelError("PARSE_FAILED", "EMAIL", "the raw mail is not valid MIME", { cause: error });
  }
  const headers = new Map<string, string[]>();
  for (const header of email.headers) headers.set(header.key, [...(headers.get(header.key) ?? []), header.value]);
  return {
    messageId: parseMessageIds(email.messageId)[0],
    subject: email.subject ?? "",
    from: singleAuthor(headers.get("from") ?? []),
    inReplyTo: parseMessageIds(email.inReplyTo),
    references: parseMessageIds(email.references),
    text: email.text,
    html: email.html,
    attachments: email.attachments.map((attachment, index) => ({
      index,
      filename: attachment.filename ?? undefined,
      contentType: attachment.mimeType.toLowerCase(),
      bytes: bytesOf(attachment.content),
    })),
    header: (name) => headers.get(name.toLowerCase()) ?? [],
  };
}

export const ATTACHMENT_REJECTIONS = ["NOT_PDF", "NOT_PDF_BYTES", "TOO_LARGE", "EMPTY", "TOO_MANY"] as const;
export type AttachmentRejection = (typeof ATTACHMENT_REJECTIONS)[number];

export type ScreenedAttachment =
  | { readonly status: "ACCEPTED"; readonly attachment: MailAttachment; readonly sha256: string }
  | { readonly status: "REJECTED"; readonly attachment: MailAttachment; readonly reason: AttachmentRejection };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export function startsWithPdfMagic(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

function rejectionOf(attachment: MailAttachment): AttachmentRejection | undefined {
  if (attachment.contentType !== PDF_CONTENT_TYPE) return "NOT_PDF";
  if (attachment.bytes.byteLength === 0) return "EMPTY";
  if (attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES) return "TOO_LARGE";
  return startsWithPdfMagic(attachment.bytes) ? undefined : "NOT_PDF_BYTES";
}

/** Accepts the first five valid PDFs in order; every other part is rejected with its reason. */
export function screenAttachments(attachments: readonly MailAttachment[]): ScreenedAttachment[] {
  let accepted = 0;
  return attachments.map((attachment) => {
    const reason = rejectionOf(attachment);
    if (reason !== undefined) return { status: "REJECTED", attachment, reason };
    if (accepted >= MAX_ATTACHMENTS_PER_MESSAGE) return { status: "REJECTED", attachment, reason: "TOO_MANY" };
    accepted += 1;
    return { status: "ACCEPTED", attachment, sha256: sha256Hex(attachment.bytes) };
  });
}

/**
 * The bytes of one accepted attachment of a raw mail, for the intake of an `INTAKE_DOCUMENT` whose
 * object is `INBOUND_MAIL` (the worker never trusts the event's index blindly: the part has to pass
 * the same screening again and match the SHA-256 the inbound recorded).
 */
export async function acceptedAttachment(raw: Uint8Array, index: number, sha256: string): Promise<Uint8Array> {
  const mail = await parseMime(raw);
  const screened = screenAttachments(mail.attachments).find((entry) => entry.attachment.index === index);
  if (screened === undefined || screened.status !== "ACCEPTED" || screened.sha256 !== sha256) {
    throw new ChannelError("INVALID", "EMAIL", `attachment ${index} of the mail is not the accepted PDF`);
  }
  return screened.attachment.bytes;
}
