// The checks on what a send says, after the policy allowed or deferred it (docs/design-brief.md §5.5):
// G2 over the model's free text (grounded in the turn's tool results and the firm's checklist; relevance
// only for a `REPLY`), then the deterministic verification (verify.ts). A template's parameters skip G2
// (its body was approved) and are checked one by one; a text the code or a person wrote skips G2 and the
// fact check, and keeps the language check. Also here: the verdict inputs computed before the policy
// (what links and contacts a text may carry) and the texts the content rules read.
import type { Guardrail, Language } from "@legajo/shared";
import type { Message } from "../domain/conversations";
import type { SendContext } from "./context";
import type { OutboundDeps } from "./deps";
import { GuardrailUnavailableError, groundingSourceOf, queryOf } from "./grounding";
import { type LinkAllowance, consoleUrlOf } from "./links";
import type { OutboundRequest } from "./types";
import { outputsOf, requiredSupplierContent, type VerifyFailure, verifyContent } from "./verify";

export type ContentOutcome =
  | { readonly ok: true; readonly guardrail?: Guardrail }
  | { readonly ok: false; readonly unavailable?: true; readonly guardrail?: Guardrail; readonly g2: boolean; readonly failures: readonly VerifyFailure[] };

/** The free text and the template parameters of a send: what the content rules and the link check read. */
export function textsOf(request: OutboundRequest): string[] {
  if (request.channel === "WHATSAPP") return [...(request.text === undefined ? [] : [request.text]), ...(request.template?.params ?? [])];
  return [request.text];
}

export function textOf(request: OutboundRequest): string | undefined {
  return request.text;
}

export function languageOf(context: Pick<SendContext, "counterpart">): Language {
  return context.counterpart === "SUPPLIER" ? "en" : "es";
}

const UploadOutput = /^https:\/\/[^\s]+\/u\/[A-Za-z0-9_-]{43}$/;

/** Upload links the turn created (`create_upload_link` results). */
export function turnUploadLinks(context: Pick<SendContext, "results">): string[] {
  return context.results.flatMap((result) => {
    const url = (result.output as { url?: unknown }).url;
    return result.tool === "create_upload_link" && typeof url === "string" && UploadOutput.test(url) ? [url] : [];
  });
}

/** What a text of this send may carry besides its own words (links.ts). */
export async function allowanceOf(deps: OutboundDeps, context: SendContext): Promise<LinkAllowance> {
  const contacts = await deps.data.parties.listContacts(context.operation.supplierId);
  const numbers = new Set<string>([context.operation.operationNumber, context.operation.invoiceNumber.replace(/\D/g, "")]);
  for (const output of outputsOf(context.results)) {
    for (const value of Object.values(output as Record<string, unknown>)) if (typeof value === "string" && /^[\d\s-]{8,}$/.test(value)) numbers.add(value.replace(/\D/g, ""));
  }
  // The firm's emails (escalation report, dossier ready for review) point at the operation's own dossier in the console.
  const links = context.counterpart === "FIRM" ? [...turnUploadLinks(context), consoleUrlOf(context.operation.operationId)] : turnUploadLinks(context);
  return { links, contacts: contacts.map((contact) => contact.email), numbers };
}

/** The importer's (or the supplier's) message a `REPLY` answers: the one named, or the last inbound. */
function questionOf(request: OutboundRequest, history: readonly Message[]): string | undefined {
  const inbound = history.filter((message) => message.direction === "IN");
  const answered = request.answers === undefined ? inbound.at(-1) : inbound.find((message) => message.messageId === request.answers);
  return answered?.body;
}

async function g2Source(deps: OutboundDeps, context: SendContext): Promise<string> {
  const checklists = await deps.data.firms.listChecklists(context.operation.firmId);
  const sources = [
    ...checklists.map((checklist) => ({ tool: "checklist", output: checklist as unknown })),
    ...context.results.map((result) => ({ tool: result.tool, output: result.output as unknown })),
  ];
  return groundingSourceOf(sources, deps.g2Limits().groundingSourceMaxChars);
}

async function runG2(deps: OutboundDeps, request: OutboundRequest, context: SendContext, text: string): Promise<{ readonly guardrail?: Guardrail; readonly failure?: string; readonly unavailable?: true }> {
  try {
    const limits = deps.g2Limits();
    const verdict = await deps.guardrail.check({ kind: request.kind, text, groundingSource: await g2Source(deps, context), query: queryOf(request.kind, questionOf(request, context.history), limits.queryMaxChars) });
    const guardrail: Guardrail = { action: verdict.action, ...(verdict.groundingScore === undefined ? {} : { groundingScore: verdict.groundingScore }) };
    return verdict.failure === undefined ? { guardrail } : { guardrail, failure: verdict.failure };
  } catch (error) {
    if (error instanceof GuardrailUnavailableError) return { unavailable: true };
    throw error;
  }
}

const G2_DETAIL: Readonly<Record<string, string>> = {
  GROUNDING: "G2: the text is not grounded in this turn's tool results",
  RELEVANCE: "G2: the reply does not answer the question",
  BLOCKED: "G2: the text touches a topic the firm answers",
  TOO_LONG: "G2: the text is longer than G2 can check whole",
};

export async function checkContent(deps: OutboundDeps, request: OutboundRequest, context: SendContext): Promise<ContentOutcome> {
  const text = textOf(request);
  let guardrail: Guardrail | undefined;
  if (request.textSource === "MODEL" && text !== undefined) {
    const g2 = await runG2(deps, request, context, text);
    if (g2.unavailable === true) return { ok: false, unavailable: true, g2: true, failures: [] };
    guardrail = g2.guardrail;
    if (g2.failure !== undefined) return { ok: false, g2: true, failures: [{ check: "FACTS", detail: G2_DETAIL[g2.failure] ?? "G2 refused the text" }], ...(guardrail === undefined ? {} : { guardrail }) };
  }
  const required = request.channel === "EMAIL" && request.counterpart === "SUPPLIER" && request.textSource === "MODEL" ? requiredSupplierContent(request.kind, context.operation.invoiceNumber, context.results) : [];
  const failures = verifyContent({
    language: languageOf(context),
    textSource: request.textSource,
    ...(text === undefined ? {} : { text }),
    ...(request.channel === "WHATSAPP" && request.template !== undefined ? { templateParams: request.template.params } : {}),
    sources: outputsOf(context.results),
    required,
  });
  if (failures.length > 0) return { ok: false, g2: false, failures, ...(guardrail === undefined ? {} : { guardrail }) };
  return { ok: true, ...(guardrail === undefined ? {} : { guardrail }) };
}
