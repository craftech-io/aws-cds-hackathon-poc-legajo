// The read-only tools of the `operations` target (docs/tool-catalog.md): the operation of the turn, its
// dossier with the deadlines already computed, the firm's checklist and the dispatch status. Every id
// comes from the scope the wrapper derived from the session (never from the model), every business
// date is the world's (`scope.nowSim`, ADR-0007) and goes out with its `…Text` already formatted.
import { DocType, MilestoneName, ok } from "@legajo/shared";
import { isOpenOperation, recentOperationsOf } from "../../channels/whatsapp/routing";
import { labelsEsAR } from "../../copy/es-AR";
import { DISPATCH_GLOSSARY, dispatchGlossaryKey } from "../../copy/dispatch-glossary";
import { OBSERVATION_LABELS } from "../../copy/observation-labels";
import type { Connector } from "../../connector/connector";
import type { Document, Observation } from "../../domain/documents";
import type { Checklist } from "../../domain/firms";
import type { Operation } from "../../domain/operations";
import type { Timer } from "../../domain/timers";
import { milestoneDueTimes } from "../../milestones/schedule";
import { atLocalTime } from "../../services/business-hours";
import type { ToolImplementation } from "../common/context";
import type { ToolInput } from "../common/define";
import type { ToolScope } from "../common/scope";
import type { OPERATIONS_TOOLS } from "./schema";
import { isoAr, textAr, textInZone } from "./time-text";

type Tools = typeof OPERATIONS_TOOLS;

/** The supplier's deadline: ETA − 4 days at 17:00 in its own zone (docs/tool-catalog.md `get_dossier`). */
export const SUPPLIER_DEADLINE = { days: -4, time: "17:00" } as const;

/** What `get_checklist` reminds the model of with every answer (ADR-0013). */
export const CHECKLIST_COVERAGE_NOTE =
  "Answer the importer only with these items. Anything they do not cover is not answered: escalate it with escalate_to_broker (OUT_OF_CHECKLIST).";

/**
 * The importer's other recent operations (ADR-0017, ADR-0019): the open ones, then the last closed, up to
 * ten in all, with number, ETA, dossier and documents, so an answer across operations is grounded on a
 * tool result of the turn, like every number the agent writes. Only an open one can be routed to.
 */
async function otherOperationsOf(connector: Pick<Connector, "operations" | "documents">, scope: Pick<ToolScope, "operationId" | "firmId" | "importerId" | "clockId">) {
  const operations = await recentOperationsOf(connector, scope);
  const others = operations.filter((operation) => operation.operationId !== scope.operationId);
  return Promise.all(
    others.map(async (operation) => {
      const documents = await connector.documents.listDocuments(operation.operationId);
      return {
        operationNumber: operation.operationNumber,
        open: isOpenOperation(operation),
        etaText: textAr(operation.eta),
        dossierStatus: operation.dossierStatus,
        dispatchStatus: operation.dispatch.status,
        documentsValid: documents.filter((document) => document.status === "VALID").length,
        missing: DocType.options.filter((docType) => !documents.some((document) => document.docType === docType && document.status !== "MISSING")),
      };
    }),
  );
}

export const getOperation: ToolImplementation<ToolInput<Tools["get_operation"]>> = async ({ connector, scope }) => {
  const operation = await connector.operations.getOperation(scope.operationId);
  const [firm, importer, supplier, otherOperations] = await Promise.all([connector.firms.getFirm(scope.firmId), connector.parties.getImporter(scope.importerId), connector.parties.getSupplier(scope.supplierId), otherOperationsOf(connector, scope)]);
  return ok({
    operation: {
      operationNumber: operation.operationNumber,
      firmName: firm.name,
      importer: { name: importer.name, contactFirstName: importer.contactFirstName },
      supplier: { name: supplier.name, country: supplier.country, timezone: supplier.timezone, language: supplier.language },
      vessel: operation.vessel,
      carrier: operation.carrier,
      regime: operation.regime,
      portOfLoading: operation.portOfLoading,
      eta: isoAr(operation.eta),
      etaText: textAr(operation.eta),
      invoiceNumber: operation.invoiceNumber,
      incoterm: operation.incoterm,
      dossierStatus: operation.dossierStatus,
      control: operation.control,
      dispatch: { status: operation.dispatch.status, ...(operation.dispatch.channel === undefined ? {} : { channel: operation.dispatch.channel }) },
    },
    nowSim: isoAr(scope.nowSim),
    nowSimText: textAr(scope.nowSim),
    otherOperations,
  });
};

function observationOut(observation: Observation) {
  return {
    observationId: observation.observationId,
    code: observation.code,
    label: OBSERVATION_LABELS[observation.code].es,
    ...(observation.field === undefined ? {} : { field: observation.field }),
    ...(observation.expected === undefined ? {} : { expected: observation.expected }),
    ...(observation.found === undefined ? {} : { found: observation.found }),
    severity: observation.severity,
    status: observation.status,
    ...(observation.responsibleParty === undefined ? {} : { responsibleParty: observation.responsibleParty }),
    attempts: observation.attempts,
  };
}

function documentOut(document: Document, observations: readonly Observation[]) {
  return {
    docType: document.docType,
    label: labelsEsAR.docType[document.docType],
    status: document.status,
    ...(document.responsibleParty === undefined ? {} : { responsibleParty: document.responsibleParty }),
    currentVersion: document.currentVersion,
    ...(document.currentDocVersionId === undefined ? {} : { currentDocVersionId: document.currentDocVersionId }),
    ...(document.receivedAtSim === undefined ? {} : { receivedAtText: textAr(document.receivedAtSim) }),
    ...(document.requestedFrom === undefined ? {} : { requestedFrom: document.requestedFrom }),
    ...(document.lastRequestedAtSim === undefined ? {} : { lastRequestedAtText: textAr(document.lastRequestedAtSim) }),
    observations: observations.filter((observation) => observation.docType === document.docType).map(observationOut),
  };
}

/** The next milestone after `nowSim`: its `TIMER#MILESTONE#` when one is scheduled, else the one the ETA gives. */
export function nextMilestoneOf(eta: string, scheduled: readonly Timer[], nowSim: string): { readonly name: string; readonly dueAtSim: string } | undefined {
  const now = Date.parse(nowSim);
  const fromTimers = scheduled
    .filter((timer) => MilestoneName.safeParse(timer.timerId).success && Date.parse(timer.dueAtSim) > now)
    .sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim))[0];
  if (fromTimers !== undefined) return { name: fromTimers.timerId, dueAtSim: fromTimers.dueAtSim };
  if (scheduled.length > 0) return undefined;
  const due = milestoneDueTimes(eta);
  const next = MilestoneName.options.map((name) => ({ name, dueAtSim: due[name] })).find((milestone) => Date.parse(milestone.dueAtSim) > now);
  return next;
}

/** Importer's deadline (`FOLLOWUP_FINAL`) and supplier's (ETA − 4 days 17:00 in its zone). */
export function deadlinesOf(operation: Pick<Operation, "eta">, supplierTimeZone: string) {
  const importer = milestoneDueTimes(operation.eta).FOLLOWUP_FINAL;
  const supplier = atLocalTime(new Date(Date.parse(operation.eta)), SUPPLIER_DEADLINE.days, SUPPLIER_DEADLINE.time, supplierTimeZone);
  return {
    importer: { atSim: isoAr(importer), text: textAr(importer) },
    supplier: { atSim: isoAr(supplier), text: textInZone(supplier, supplierTimeZone), timezone: supplierTimeZone },
  };
}

async function dossierParts(connector: Connector, scope: ToolScope) {
  return Promise.all([
    connector.operations.getOperation(scope.operationId),
    connector.documents.listDocuments(scope.operationId),
    connector.documents.listObservations(scope.operationId),
    connector.parties.getSupplier(scope.supplierId),
    connector.timers.listTimers(scope.operationId, { kind: "MILESTONE", status: "SCHEDULED" }),
    connector.operations.listEscalations(scope.operationId, { status: "OPEN" }),
  ]);
}

export const getDossier: ToolImplementation<ToolInput<Tools["get_dossier"]>> = async ({ connector, scope }) => {
  const [operation, documents, observations, supplier, milestones, escalations] = await dossierParts(connector, scope);
  const ordered = DocType.options.flatMap((docType) => documents.filter((document) => document.docType === docType));
  const next = nextMilestoneOf(operation.eta, milestones, scope.nowSim);
  return ok({
    complete: ordered.length === DocType.options.length && ordered.every((document) => document.status === "VALID"),
    missing: ordered.filter((document) => document.status === "MISSING").map((document) => document.docType),
    documents: ordered.map((document) => documentOut(document, observations)),
    deadlines: deadlinesOf(operation, supplier.timezone),
    ...(next === undefined ? {} : { nextMilestone: { name: next.name, dueAtSim: isoAr(next.dueAtSim), text: textAr(next.dueAtSim) } }),
    openEscalations: escalations.length,
  });
};

/** `CI v1 · PL v2 · CO v1`: the versions an answer was built from. */
function versionsText(checklists: readonly { readonly docType: DocType; readonly checklistVersion: number }[]): string {
  const short: Readonly<Record<DocType, string>> = { COMMERCIAL_INVOICE: "CI", PACKING_LIST: "PL", CERTIFICATE_OF_ORIGIN: "CO" };
  return checklists.map((checklist) => `${short[checklist.docType]} v${checklist.checklistVersion}`).join(" · ");
}

export const getChecklist: ToolImplementation<ToolInput<Tools["get_checklist"]>> = async ({ connector, scope, input }) => {
  const firm = await connector.firms.getFirm(scope.firmId);
  const found = input.docType === undefined ? await connector.firms.listChecklists(scope.firmId) : [await connector.firms.getChecklist(scope.firmId, input.docType)];
  const present = found.filter((checklist): checklist is Checklist => checklist !== undefined);
  const checklists = DocType.options.flatMap((docType) => present.filter((checklist) => checklist.docType === docType));
  return ok({
    firmName: firm.name,
    checklistVersion: versionsText(checklists),
    items: checklists.flatMap((checklist) => checklist.items.map((item) => ({ itemId: item.itemId, docType: item.docType, text: item.text, required: item.required }))),
    coverageNote: CHECKLIST_COVERAGE_NOTE,
  });
};

export const getDispatchStatus: ToolImplementation<ToolInput<Tools["get_dispatch_status"]>> = async ({ connector, scope }) => {
  const { dispatch } = await connector.operations.getOperation(scope.operationId);
  if (dispatch.status === "NONE") return ok({ status: "NONE" });
  const glossary = await connector.reference.getDispatchGlossary(dispatch.status, dispatch.channel);
  const key = dispatchGlossaryKey(dispatch.status, dispatch.channel);
  const explanation = glossary?.text ?? (key === undefined ? undefined : DISPATCH_GLOSSARY[key].explanation);
  const occurredAt = dispatch.occurredAtSim ?? dispatch.history.at(-1)?.occurredAtSim;
  return ok({
    status: dispatch.status,
    ...(dispatch.channel === undefined ? {} : { channel: dispatch.channel }),
    ...(occurredAt === undefined ? {} : { occurredAtText: textAr(occurredAt) }),
    ...(explanation === undefined ? {} : { genericExplanation: explanation }),
  });
};
