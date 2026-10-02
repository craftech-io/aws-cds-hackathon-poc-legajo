// The email a send becomes (docs/architecture-integrations.md §1): everything around the body is built
// by the code, never by the model.
//
//   to the supplier   From and Reply-To the operation's thread address, named "<firm> via Legajo listo";
//                     the subject of copy/en.ts by kind ("[Op 4471] Missing documents: …"); In-Reply-To
//                     the supplier's last email of the thread (ours when it never answered) and
//                     References the thread's chain; `X-Legajo-Operation` and `X-Legajo-Request`
//   to the firm       From `avisos@`, named after the product; subject and body from copy/ (Spanish)
//
// The single SES client checks every header value again (no CR/LF, RFC 2047 names) and fences the
// recipient by the SYSTEM profile.
import { NOTICES_ADDRESS, ToolError, type DocType, type ObservationCode, type SupplierEmailKind } from "@legajo/shared";
import { supplierEmailEn } from "../../copy/en";
import { PRODUCT_NAME } from "../../copy/helpers";
import type { EmailSendRequest } from "../../channels/email/outbound";
import type { LegajoRequestInput } from "../../channels/email/headers";
import type { Message } from "../../domain/conversations";
import type { Operation } from "../../domain/operations";

/** References an email carries at most (the SES client refuses more). */
const MAX_REFERENCES = 50;

/** What the pipeline hands the SES client, minus the ids of the call (`clockId`, `messageId`, …). */
export type RenderedEmail = Pick<Extract<EmailSendRequest, { profile: "SYSTEM" }>, "from" | "to" | "replyTo" | "subject" | "text" | "lang" | "inReplyTo" | "references" | "request" | "operationNumber">;

export interface ThreadHeaders {
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  /** Subject of the thread's last email, for a `REPLY`. */
  readonly subject?: string;
}

/** In-Reply-To the supplier's last email (ours when it never answered) and the chain of the thread. */
export function threadHeaders(messages: readonly Message[], contactAddress: string | undefined): ThreadHeaders {
  const thread = messages
    .filter((message) => message.channel === "EMAIL" && message.counterpart === "SUPPLIER" && message.rfcMessageId !== undefined)
    .filter((message) => message.direction === "IN" || contactAddress === undefined || message.to === contactAddress)
    .sort((a, b) => a.sentAtSim.localeCompare(b.sentAtSim));
  const references = [...new Set(thread.map((message) => message.rfcMessageId ?? ""))].slice(-MAX_REFERENCES);
  const answeredBy = thread.filter((message) => message.direction === "IN").at(-1) ?? thread.at(-1);
  return {
    references,
    ...(answeredBy?.rfcMessageId === undefined ? {} : { inReplyTo: answeredBy.rfcMessageId }),
    ...(thread.at(-1)?.subject === undefined ? {} : { subject: thread.at(-1)?.subject }),
  };
}

export interface SupplierEmailInput {
  readonly operation: Pick<Operation, "operationNumber" | "invoiceNumber" | "threadAddress">;
  readonly firmName: string;
  readonly to: string;
  readonly kind: SupplierEmailKind;
  readonly text: string;
  readonly docTypes: readonly DocType[];
  /** The observation of a `CORRECTION_REQUEST` (`refs.observationIds`, read by the pipeline). */
  readonly observation?: { readonly code: ObservationCode; readonly docType: DocType };
  readonly thread: ThreadHeaders;
}

export function renderSupplierEmail(input: SupplierEmailInput): RenderedEmail {
  if (input.kind === "CORRECTION_REQUEST" && input.observation === undefined) throw new ToolError("INVALID", "a correction request names the observation in refs.observationIds", "CONTENT_INVALID");
  const subject = supplierEmailEn.subject(input.kind, {
    operationNumber: input.operation.operationNumber,
    invoiceNumber: input.operation.invoiceNumber,
    docTypes: input.docTypes,
    ...(input.observation === undefined ? {} : { observation: input.observation }),
    ...(input.thread.subject === undefined ? {} : { threadSubject: input.thread.subject }),
  });
  const request: LegajoRequestInput = {
    kind: input.kind,
    docTypes: [...input.docTypes],
    observationCodes: input.observation === undefined ? [] : [input.observation.code],
  };
  return {
    from: { address: input.operation.threadAddress, displayName: supplierEmailEn.displayName(input.firmName) },
    to: input.to,
    replyTo: input.operation.threadAddress,
    subject,
    text: input.text,
    lang: "en",
    ...(input.thread.inReplyTo === undefined ? {} : { inReplyTo: input.thread.inReplyTo }),
    references: [...input.thread.references],
    request,
    operationNumber: input.operation.operationNumber,
  };
}

/** An email to the firm's own mailbox (escalations, ready for review), from `avisos@`. */
export function renderFirmEmail(input: { readonly operationNumber: string; readonly to: string; readonly subject: string; readonly text: string }): RenderedEmail {
  return {
    from: { address: NOTICES_ADDRESS, displayName: PRODUCT_NAME },
    to: input.to,
    subject: input.subject,
    text: input.text,
    lang: "es",
    references: [],
    operationNumber: input.operationNumber,
  };
}
