// Step 4 and 5 of the pipeline (pipeline.ts): the content checks, then the render of what passed. A
// WhatsApp template with a URL button gets the upload link this turn created (a `create_upload_link`
// result) or a new one (docs/architecture-integrations.md §7); its buttons get their nonces. An email
// gets the code's subject, sender and thread headers. Nothing is issued for a text that failed its
// checks. `renderSend` alone re-renders a deferred send when its timer fires (its text was checked
// when it was deferred).
import { ToolError, type DocType } from "@legajo/shared";
import type { MetaMessage } from "../channels/whatsapp/meta-message";
import type { SendContext } from "./context";
import { type ContentOutcome, checkContent } from "./content";
import type { OutboundDeps, WhatsAppRoute } from "./deps";
import type { MessageContent } from "./persist";
import { type RenderedEmail, renderFirmEmail, renderSupplierEmail, threadHeaders } from "./render/email";
import { needsUploadLink, renderWhatsApp } from "./render/whatsapp";
import { OUTBOUND_REASON, type OutboundRequest } from "./types";

export interface RenderedSend {
  readonly content: MessageContent;
  readonly whatsapp?: { readonly message: MetaMessage; readonly route: WhatsAppRoute };
  readonly email?: RenderedEmail;
  /** The upload link a template's URL button carries: a deferred send keeps it for when it fires. */
  readonly uploadToken?: string;
}

export interface Prepared {
  readonly content: ContentOutcome;
  readonly rendered?: RenderedSend;
}

const PENDING_STATUSES = new Set(["MISSING", "WITH_OBSERVATION"]);

/** The token of the upload link this turn created, if any (`create_upload_link` result). */
function turnUploadToken(context: Pick<SendContext, "results">): string | undefined {
  const tokens = context.results.flatMap((result) => {
    const token = (result.output as { token?: unknown }).token;
    return result.tool === "create_upload_link" && typeof token === "string" ? [token] : [];
  });
  return tokens.at(-1);
}

async function uploadToken(deps: OutboundDeps, request: OutboundRequest, context: SendContext, reuse?: string): Promise<string> {
  const current = reuse ?? turnUploadToken(context);
  if (current !== undefined) {
    const link = await deps.data.runtime.getUploadLink(current);
    if (link !== undefined && link.operationId === context.operation.operationId && Date.parse(link.expiresAtReal) > deps.wallClock().getTime()) return current;
  }
  let docTypes: readonly DocType[] | undefined = request.refs?.docTypes;
  if (docTypes === undefined || docTypes.length === 0) {
    const documents = await deps.data.documents.listDocuments(context.operation.operationId);
    docTypes = documents.filter((document) => PENDING_STATUSES.has(document.status)).map((document) => document.docType);
  }
  return (await deps.uploadLinks.issue({ operationId: context.operation.operationId, firmId: context.operation.firmId, docTypes })).token;
}

async function renderWhatsAppSend(deps: OutboundDeps, request: Extract<OutboundRequest, { channel: "WHATSAPP" }>, context: SendContext, messageId: string, reuseToken?: string): Promise<RenderedSend> {
  const { importer } = context;
  if (importer === undefined) throw new ToolError("NOT_FOUND", "the importer of the operation has no registered phone", OUTBOUND_REASON.NO_RECIPIENT);
  const route = deps.whatsapp(context.operation.clockId, importer.phoneE164);
  const token = request.template !== undefined && needsUploadLink(request.template.name) ? await uploadToken(deps, request, context, reuseToken) : undefined;
  const rendered = await renderWhatsApp(deps.data.runtime, {
    messageId,
    to: importer.phoneE164,
    ...(request.text === undefined ? {} : { text: request.text }),
    ...(request.template === undefined ? {} : { template: request.template }),
    ...(request.buttons === undefined ? {} : { buttons: request.buttons }),
    ...(token === undefined ? {} : { uploadToken: token }),
    nonceKey: deps.nonceKey(),
    operationId: context.operation.operationId,
    importerId: importer.importerId,
    phoneHash: importer.phoneHash,
    clockId: context.operation.clockId,
    now: deps.wallClock(),
  });
  return {
    content: {
      to: importer.phoneE164,
      from: route.from,
      body: rendered.body,
      ...(rendered.template === undefined ? {} : { template: rendered.template }),
      buttons: rendered.buttons,
      simulated: route.mode === "simulated",
    },
    whatsapp: { message: rendered.message, route },
    ...(token === undefined ? {} : { uploadToken: token }),
  };
}

async function renderEmailSend(deps: OutboundDeps, request: Extract<OutboundRequest, { channel: "EMAIL" }>, context: SendContext): Promise<RenderedSend> {
  const { operation, to } = context;
  if (to === undefined) throw new ToolError("NOT_FOUND", "no registered recipient for this email", OUTBOUND_REASON.NO_RECIPIENT);
  if (request.counterpart === "FIRM") {
    const email = renderFirmEmail({ operationNumber: operation.operationNumber, to, subject: request.subject, text: request.text });
    return { content: { to, from: email.from.address, body: email.text, subject: email.subject, simulated: false }, email };
  }
  if (context.firm === undefined) throw new ToolError("UNAVAILABLE", "the firm of the operation could not be read");
  const observationId = request.refs?.observationIds?.[0];
  const observation = observationId === undefined ? undefined : await deps.data.documents.findObservation(operation.operationId, observationId);
  const thread = threadHeaders(await deps.data.conversations.listMessages(operation.operationId, { channel: "EMAIL" }), to);
  const email = renderSupplierEmail({
    operation,
    firmName: context.firm.name,
    to,
    kind: request.kind,
    text: request.text,
    docTypes: request.refs?.docTypes ?? [],
    ...(observation === undefined ? {} : { observation: { code: observation.code, docType: observation.docType } }),
    thread,
  });
  return {
    content: { to, from: email.from.address, body: email.text, subject: email.subject, references: email.references ?? [], ...(email.inReplyTo === undefined ? {} : { inReplyTo: email.inReplyTo }), simulated: false },
    email,
  };
}

/** Renders a send whose content already passed its checks; `reuseToken` keeps a deferred send's link. */
export function renderSend(deps: OutboundDeps, request: OutboundRequest, context: SendContext, messageId: string, reuseToken?: string): Promise<RenderedSend> {
  return request.channel === "WHATSAPP" ? renderWhatsAppSend(deps, request, context, messageId, reuseToken) : renderEmailSend(deps, request, context);
}

export async function prepareContent(deps: OutboundDeps, request: OutboundRequest, context: SendContext, messageId: string): Promise<Prepared> {
  const content = await checkContent(deps, request, context);
  if (!content.ok) return { content };
  return { content, rendered: await renderSend(deps, request, context, messageId) };
}
