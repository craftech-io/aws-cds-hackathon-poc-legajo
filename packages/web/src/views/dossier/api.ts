// Calls of the dossier view (docs/tool-catalog.md "Procedimientos de la consola"), every one typed by
// the BFF's `AppRouter`: the reads (`operations.get`, `operations.timeline`, `operations.documentUrl`,
// `audit.list`), the actions of the `dossier` and `conversation` routers, and `clock.advanceTo` of
// "Avanzar hasta ahí". Each action's input is also validated in the browser with the one schema of its
// procedure (@legajo/shared console-inputs, the same the scenarios and the BFF router use), so a bad id
// never leaves; the view only needs to know an action succeeded and reads the dossier again. Every id
// travels as the router gets it; the firm comes from the token.
import { CONSOLE_CHANGE_INPUTS, type ConsoleChangeInputs, type ConsoleChangePath, type DocType, DocVersionId, IsoInstant, OperationId } from "@legajo/shared";
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

/**
 * "Avanzar hasta ahí": the paused clock of the operation's world moved exactly to the pending's
 * `dueAtSim` (`clock.advanceTo`; `WORLD_BUSY` while the world is busy, one `CLOCK_MOVES` of a guest world).
 */
export async function advanceClockTo(trpc: ConsoleClient, clockId: string, toSim: string): Promise<void> {
  await trpc.clock.advanceTo.mutate({ clockId, toSim: IsoInstant.parse(toSim) });
}

// ---- Actions (docs/tool-catalog.md, handlers of direct invocation) --------------------------------

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
export type DossierRequest = { readonly [P in DossierPath]: { readonly path: P; readonly input: ConsoleChangeInputs[P] } }[DossierPath];

function requestOf(action: DossierAction): DossierRequest {
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
export function actionRequest(action: DossierAction): DossierRequest {
  const request = requestOf(action);
  CONSOLE_CHANGE_INPUTS[request.path].parse(request.input);
  return request;
}

/** The typed procedure of each request; the view reads the dossier again, so the answer is not kept. */
function send(trpc: ConsoleClient, request: DossierRequest): Promise<unknown> {
  switch (request.path) {
    case "dossier.approve":
      return trpc.dossier.approve.mutate(request.input);
    case "dossier.reopen":
      return trpc.dossier.reopen.mutate(request.input);
    case "dossier.waiveObservation":
      return trpc.dossier.waiveObservation.mutate(request.input);
    case "dossier.classifyDocument":
      return trpc.dossier.classifyDocument.mutate(request.input);
    case "conversation.take":
      return trpc.conversation.take.mutate(request.input);
    case "conversation.release":
      return trpc.conversation.release.mutate(request.input);
    case "conversation.send":
      return trpc.conversation.send.mutate(request.input);
  }
}

export async function runDossierAction(trpc: ConsoleClient, action: DossierAction): Promise<void> {
  await send(trpc, actionRequest(action));
}
