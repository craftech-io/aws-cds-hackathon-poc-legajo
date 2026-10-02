// `request_approval` without the tool wrapper (docs/tool-catalog.md, FL-072, FL-074, ADR-0010): the
// dossier goes to `READY_FOR_REVIEW` when every document is `VALID` (or its only observations were
// waived by the firm), the KPI row records `completedAtSim`, and the firm's mailbox gets "listo para
// revisión" from `avisos@` through the pipeline. It never approves: no input reaches `APPROVED`, and the
// connector refuses `APPROVED` without a human broker. Idempotent: a dossier already waiting for review
// answers as it is.
import { DocType, ToolError } from "@legajo/shared";
import type { AgentMode, TurnTrigger } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import { firmEsAR } from "../../copy/es-AR-firm";
import type { Actor } from "../../domain/common";
import type { Document, Observation } from "../../domain/documents";
import type { Operation } from "../../domain/operations";
import { type OutboundSender, derivedMessageId } from "../../escalations/ports";
import { consoleUrlOf } from "../../outbound/links";
import type { Logger } from "../../lib/log";
import type { OutboundResult } from "../../outbound/types";
import { kpiRefOf } from "../../turns/record";

const OPEN_OBSERVATION: ReadonlySet<Observation["status"]> = new Set(["OPEN", "CORRECTION_REQUESTED", "ESCALATED"]);

/** A document that needs nothing else: `VALID`, or with observations the firm waived and none open. */
export function documentDone(document: Pick<Document, "docType" | "status">, observations: readonly Pick<Observation, "docType" | "status">[]): boolean {
  if (document.status === "VALID") return true;
  if (document.status !== "WITH_OBSERVATION") return false;
  const own = observations.filter((observation) => observation.docType === document.docType);
  return own.some((observation) => observation.status === "WAIVED_BY_BROKER") && !own.some((observation) => OPEN_OBSERVATION.has(observation.status));
}

/** The documents that keep the dossier from review, in checklist order. */
export function notDone(documents: readonly Pick<Document, "docType" | "status">[], observations: readonly Pick<Observation, "docType" | "status">[]): DocType[] {
  const pending = new Set(documents.filter((document) => !documentDone(document, observations)).map((document) => document.docType));
  return DocType.options.filter((docType) => pending.has(docType));
}

export interface ApprovalDeps {
  readonly data: Pick<Connector, "operations" | "documents" | "parties" | "metrics">;
  readonly send: OutboundSender;
  readonly agentMode: AgentMode;
  readonly wallClock: () => Date;
  readonly log: Logger;
}

export interface ApprovalInput {
  readonly operationId: string;
  readonly summary: string;
  readonly actor: Actor;
  readonly nowSim: string;
  readonly trigger?: TurnTrigger;
  readonly correlationId: string;
  readonly refs?: Readonly<Record<string, string>>;
}

export interface ApprovalRequested {
  readonly operation: Operation;
  /** False when the dossier was already waiting for review. */
  readonly changed: boolean;
  readonly email?: OutboundResult["status"];
}

async function recordCompletion(operation: Operation, nowSim: string, deps: ApprovalDeps): Promise<void> {
  const ref = kpiRefOf(operation);
  if ((await deps.data.metrics.getKpi(ref)) === undefined) await deps.data.metrics.incrementKpi(ref, {}, { agentMode: deps.agentMode });
  await deps.data.metrics.updateKpi(ref, { dossierStatus: "READY_FOR_REVIEW", completedAtSim: nowSim });
}

async function emailFirm(operation: Operation, input: ApprovalInput, deps: ApprovalDeps): Promise<OutboundResult["status"]> {
  const [importer, supplier] = await Promise.all([deps.data.parties.getImporter(operation.importerId), deps.data.parties.getSupplier(operation.supplierId)]);
  const email = firmEsAR.readyForReviewEmail({ operationNumber: operation.operationNumber, importerName: importer.name, supplierName: supplier.name, summary: input.summary, consoleUrl: consoleUrlOf(operation.operationId) });
  const completedAt = operation.dossierHistory.at(-1)?.atSim ?? input.nowSim;
  const result = await deps.send(
    {
      channel: "EMAIL",
      counterpart: "FIRM",
      operationId: operation.operationId,
      // The firm's mailbox takes one kind (policy/kinds.ts `TO_FIRM`): the notice that it has to act.
      kind: "ESCALATION",
      author: "SYSTEM",
      textSource: "CODE",
      eventAtSim: input.nowSim,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      subject: email.subject,
      text: email.body,
      messageId: derivedMessageId("READY", operation.operationId, completedAt),
    },
    { actor: input.actor, correlationId: input.correlationId, log: deps.log, refs: { ...(input.refs ?? {}), operationId: operation.operationId } },
  );
  return result.status;
}

export async function requestApproval(input: ApprovalInput, deps: ApprovalDeps): Promise<ApprovalRequested> {
  const current = await deps.data.operations.getOperation(input.operationId);
  if (current.dossierStatus === "READY_FOR_REVIEW") return { operation: current, changed: false };
  if (current.dossierStatus === "APPROVED") throw new ToolError("CONFLICT", "the dossier is already approved", "DOSSIER_APPROVED");
  const [documents, observations] = await Promise.all([deps.data.documents.listDocuments(current.operationId), deps.data.documents.listObservations(current.operationId)]);
  const pending = notDone(documents, observations);
  if (pending.length > 0) throw new ToolError("NOT_COMPLETE", `not every document is valid yet: ${pending.join(", ")}`, "NOT_COMPLETE");
  const operation = await deps.data.operations.transitionDossier({
    operationId: current.operationId,
    to: "READY_FOR_REVIEW",
    atSim: input.nowSim,
    atReal: deps.wallClock().toISOString(),
    by: input.actor,
    reason: "every document is valid",
    expectedVersion: current.version,
  });
  await recordCompletion(operation, input.nowSim, deps);
  const email = await emailFirm(operation, input, deps);
  return { operation, changed: true, email };
}
