// A mail a supplier (or anyone else) writes to an operation's thread address, delivered the way the
// `ops-poc` receipt rule delivers it: the raw MIME under the rule's prefix and the receipt event to
// `InboundEmail`. The flows use it for what the supplier simulator does not send by itself (a mail from
// an address that is not the ACTIVE contact, a spoofed or infected one, an injected body, a chosen PDF
// version); a reply of the simulator travels through the mailroom instead (stage/mailroom.ts).
import type { InboundEmailResult } from "@legajo/bff/channels/email/inbound";
import type { DocType } from "@legajo/shared";
import { seedKeys } from "@legajo/shared";
import type { SentEmail } from "./fakes/aws";
import { LOCAL_BUCKETS, MAIL_ROUTES } from "./stage/context";
import { type Verdict, mimeOf, receiptOf, rfcMessageIdOf } from "./stage/mailroom";
import type { FlowWorld } from "./world";

export interface SupplierMailInput {
  readonly operationId: string;
  /** The author; the operation supplier's ACTIVE contact by default. */
  readonly from?: string;
  readonly subject?: string;
  readonly text: string;
  /** PDFs of the seed (`pdfs/<templateOperation>/<docType>-v<version>.pdf`), or raw bytes. */
  readonly pdfs?: ReadonlyArray<{ readonly templateOperation: string; readonly docType: DocType; readonly version: number; readonly filename?: string } | { readonly bytes: Uint8Array; readonly filename: string }>;
  /** `In-Reply-To` our latest email of the operation by default; `null` for a mail that answers nothing. */
  readonly inReplyTo?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly verdicts?: Partial<Record<Verdict, string>>;
}

let counter = 0;

/** Delivers one mail to the operation's thread address; answers what `InboundEmail` returned. */
export async function supplierMail(world: FlowWorld, input: SupplierMailInput): Promise<InboundEmailResult> {
  const operation = await world.data.operations.getOperation(input.operationId);
  const contacts = await world.data.parties.listContacts(operation.supplierId);
  const from = input.from ?? contacts.find((contact) => contact.status === "ACTIVE")?.email ?? "";
  const ours = (await world.messages(input.operationId)).filter((message) => message.direction === "OUT" && message.channel === "EMAIL" && message.providerMessageId !== undefined);
  const answered = input.inReplyTo === undefined ? ours.at(-1)?.providerMessageId : (input.inReplyTo ?? undefined);
  counter += 1;
  const messageId = `supplier-local-${String(counter).padStart(6, "0")}`;
  const attachments = (input.pdfs ?? []).map((pdf) => {
    if ("bytes" in pdf) return { FileName: pdf.filename, RawContent: pdf.bytes, ContentType: "application/pdf" };
    const body = world.seed.get(seedKeys.pdf(pdf.templateOperation, pdf.docType, pdf.version));
    if (body === undefined) throw new Error(`no ${pdf.docType} v${pdf.version} of ${pdf.templateOperation} in the seed`);
    return { FileName: pdf.filename ?? `${pdf.docType.toLowerCase()}.pdf`, RawContent: body, ContentType: "application/pdf" };
  });
  const headers = [
    ...(answered === undefined ? [] : [{ Name: "In-Reply-To", Value: rfcMessageIdOf(answered) }, { Name: "References", Value: rfcMessageIdOf(answered) }]),
    ...Object.entries(input.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
  ];
  const sent: SentEmail = {
    messageId,
    input: {
      FromEmailAddress: from,
      Destination: { ToAddresses: [operation.threadAddress] },
      Content: { Simple: { Subject: { Data: input.subject ?? `Re: [Op ${operation.operationNumber}] Documents` }, Body: { Text: { Data: input.text } }, Headers: headers, Attachments: attachments } },
    },
  };
  const sesMessageId = `inbound-${messageId}`;
  world.aws.objects.put({ bucket: LOCAL_BUCKETS.mail, key: `${MAIL_ROUTES.ops}${sesMessageId}`, body: mimeOf(sent), contentType: "message/rfc822" });
  const result = (await world.entries.inboundEmail(receiptOf({ sent, sesMessageId, recipient: operation.threadAddress, at: world.realNow(), ...(input.verdicts === undefined ? {} : { verdicts: input.verdicts }) }))) as InboundEmailResult;
  await world.entries.settle();
  return result;
}
