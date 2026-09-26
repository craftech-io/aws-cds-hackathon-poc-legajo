// Calls of the dossier view (docs/tool-catalog.md "Procedimientos de la consola"). The reads
// (`operations.get`, `operations.timeline`, `operations.documentUrl`, `audit.list`) are typed by the
// BFF's router. The actions of the `dossier` and `conversation` routers are called by name, each
// input validated with the one schema of its procedure (@legajo/shared console-inputs, the same the
// scenarios and the BFF router use), and their answers with zod: the view only needs to know they
// succeeded and reads the dossier again. Every id travels as the router gets it; the firm comes from the token.
import { CONSOLE_CHANGE_INPUTS, type ConsoleChangeInputs, type ConsoleChangePath, type DocType, DocVersionId, OperationId } from "@legajo/shared";
import { getUntypedClient } from "@trpc/client";
import { z } from "zod";
import type { ConsoleClient } from "../../lib/trpc";
import type { BrokerTemplate } from "./dossier-model";
import type { DecisionData, DossierData, TimelineData } from "./types";

/** Most decisions of the operation the timeline merges (AUDIT_LIST_LIMIT of the `audit` router). */
const TIMELINE_DECISIONS_LIMIT = 200;

export interface DossierBundle {
  readonly dossier: DossierData;
  readonly timeline: TimelineData;
  readonly decisions: readonly DecisionData[];
}

/**
 * The dossier, then its timeline and its decisions, read together so the view shows one moment. The
 * decisions are asked for in the operation's own world (a firm may have more than one).
 */
export async function fetchDossier(trpc: ConsoleClient, operationId: string, signal: AbortSignal): Promise<DossierBundle> {
  const input = { operationId: OperationId.parse(operationId) };
  const dossier = await trpc.operations.get.query(input, { signal });
  const [timeline, audit] = await Promise.all([
    trpc.operations.timeline.query(input, { signal }),
    trpc.audit.list.query({ ...input, clockId: dossier.operation.clockId, limit: TIMELINE_DECISIONS_LIMIT }, { signal }),
  ]);
  return { dossier, timeline, decisions: audit.decisions };
}

/** A 5-minute download link of one version (the PDF never renders in the console's origin). */
export async function fetchDocumentUrl(trpc: ConsoleClient, docVersionId: string): Promise<string> {
  const { url } = await trpc.operations.documentUrl.query({ docVersionId: DocVersionId.parse(docVersionId) });
  return url;
}

// ---- Actions (docs/tool-catalog.md, handlers of direct invocation) --------------------------------

/** Every action answers an object; its fields are the router's, the view reads the dossier again. */
const Done = z.looseObject({});

async function mutate(trpc: ConsoleClient, path: string, input: Readonly<Record<string, unknown>>): Promise<void> {
  Done.parse(await getUntypedClient(trpc).mutation(path, input));
}

export type DossierAction =
  | { readonly type: "approve"; readonly operationId: string }
  | { readonly type: "reopen"; readonly operationId: string; readonly reason: string }
  | { readonly type: "waive"; readonly operationId: string; readonly observationId: string; readonly reason: string }
  | { readonly type: "classify"; readonly operationId: string; readonly docVersionId: string; readonly docType: DocType }
  | { readonly type: "discard"; readonly operationId: string; readonly docVersionId: string }
  | { readonly type: "take"; readonly operationId: string }
  | { readonly type: "release"; readonly operationId: string }
  | { readonly type: "sendText"; readonly operationId: string; readonly text: string }
  | { readonly type: "sendTemplate"; readonly operationId: string; readonly template: BrokerTemplate };

type DossierPath = Extract<ConsoleChangePath, `dossier.${string}` | `conversation.${string}`>;
type Request = { readonly [P in DossierPath]: { readonly path: P; readonly input: ConsoleChangeInputs[P] } }[DossierPath];

function requestOf(action: DossierAction): Request {
  const { operationId } = action;
  switch (action.type) {
    case "approve":
      return { path: "dossier.approve", input: { operationId } };
    case "reopen":
      return { path: "dossier.reopen", input: { operationId, reason: action.reason } };
    case "waive":
      return { path: "dossier.waiveObservation", input: { operationId, observationId: action.observationId, reason: action.reason } };
    case "classify":
      return { path: "dossier.classifyDocument", input: { operationId, docVersionId: action.docVersionId, outcome: "CLASSIFY", docType: action.docType } };
    case "discard":
      return { path: "dossier.classifyDocument", input: { operationId, docVersionId: action.docVersionId, outcome: "DISCARD" } };
    case "take":
      return { path: "conversation.take", input: { operationId } };
    case "release":
      return { path: "conversation.release", input: { operationId } };
    case "sendText":
      return { path: "conversation.send", input: { operationId, text: action.text } };
    case "sendTemplate":
      return { path: "conversation.send", input: { operationId, template: action.template } };
  }
}

/** Procedure and input of each action; ids and fields are validated before they leave the browser. */
export function actionRequest(action: DossierAction): { readonly path: string; readonly input: Readonly<Record<string, unknown>> } {
  const { path, input } = requestOf(action);
  return { path, input: CONSOLE_CHANGE_INPUTS[path].parse(input) as Readonly<Record<string, unknown>> };
}

export function runDossierAction(trpc: ConsoleClient, action: DossierAction): Promise<void> {
  const { path, input } = actionRequest(action);
  return mutate(trpc, path, input);
}
