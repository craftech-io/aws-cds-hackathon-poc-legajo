// `operations` router (docs/tool-catalog.md, FL-005, FL-080, FL-081): "Nueva operación" from the
// platform (`create_operation`, which spends the guest world's `NEW_OPERATIONS` itself), the list of a world's operations, the
// dossier of one (documents, versions, observations, escalations, parties and the "con error de
// proceso" flag of `OPSTATE#`), its timeline with the pending timers and their reason, and the
// 5-minute download link of a document version. Every id of the input is fenced to the principal's
// firm before these run (routers/trpc.ts); a version is resolved through its own operation.
import { z } from "zod";
import { DOC_TYPE_SHORT, DocVersionId, DossierStatus, OperationId } from "@legajo/shared";
import { parseDocVersionId } from "../domain/documents";
import { CreateOperationInput } from "../services/operations-admin/create-operation";
import { WorldFields, worldOf } from "./clock";
import { runDirect } from "./console-services";
import { DOCUMENT_URL_TTL_SECONDS, downloadFilename } from "./document-url";
import { refusal } from "./errors";
import {
  documentView,
  escalationView,
  importerView,
  observationView,
  operationSummary,
  partyNames,
  pendingTimerView,
  supplierView,
  timelineOf,
  versionView,
} from "./operation-views";
import { firmProcedure, router } from "./trpc";

const ListInput = WorldFields.extend({ statuses: z.array(DossierStatus).min(1).max(DossierStatus.options.length).optional() }).strict().prefault({});
const OperationInput = z.object({ operationId: OperationId }).strict();

export const operationsRouter = router({
  create: firmProcedure.input(CreateOperationInput).mutation(({ ctx, input }) => runDirect(ctx, "create_operation", input)),

  list: firmProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const data = ctx.deps.connector;
    const clockId = await worldOf(ctx, input.clockId);
    const operations = await data.operations.listOperations(ctx.principal.firmId, { clockId, ...(input.statuses ? { statuses: input.statuses } : {}) });
    const [names, open, details] = await Promise.all([
      partyNames(data, operations),
      data.operations.listOpenEscalationsByFirm(ctx.principal.firmId),
      Promise.all(operations.map(async (operation) => ({ documents: await data.documents.listDocuments(operation.operationId), state: await data.world.getOpState(operation.operationId) }))),
    ]);
    return {
      clockId,
      operations: operations.map((operation, index) => ({
        ...operationSummary(operation),
        importerName: names.importers.get(operation.importerId) ?? null,
        supplierName: names.suppliers.get(operation.supplierId) ?? null,
        documents: (details[index]?.documents ?? []).map(documentView),
        openEscalations: open.filter((escalation) => escalation.operationId === operation.operationId).length,
        processError: details[index]?.state?.processError !== undefined,
      })),
    };
  }),

  get: firmProcedure.input(OperationInput).query(async ({ ctx, input }) => {
    const data = ctx.deps.connector;
    const operation = await data.operations.getOperation(input.operationId);
    await ctx.firmScope.assertFirm(operation.firmId);
    const [importer, supplier, contacts, documents, versions, observations, escalations, state] = await Promise.all([
      data.parties.getImporter(operation.importerId),
      data.parties.getSupplier(operation.supplierId),
      data.parties.listContacts(operation.supplierId),
      data.documents.listDocuments(operation.operationId),
      data.documents.listVersions(operation.operationId),
      data.documents.listObservations(operation.operationId),
      data.operations.listEscalations(operation.operationId),
      data.world.getOpState(operation.operationId),
    ]);
    return {
      operation: { ...operationSummary(operation), incoterm: operation.incoterm, incotermPlace: operation.incotermPlace, invoiceNumber: operation.invoiceNumber, regime: operation.regime },
      importer: importerView(importer),
      supplier: supplierView(supplier, contacts),
      documents: documents.map(documentView),
      versions: versions.map(versionView),
      observations: observations.map(observationView),
      escalations: escalations.map(escalationView),
      processError: state?.processError ?? null,
    };
  }),

  timeline: firmProcedure.input(OperationInput).query(async ({ ctx, input }) => {
    const data = ctx.deps.connector;
    const operation = await data.operations.getOperation(input.operationId);
    await ctx.firmScope.assertFirm(operation.firmId);
    const [messages, notes, escalations, timers] = await Promise.all([
      data.conversations.listMessages(operation.operationId),
      data.conversations.listTurnNotes(operation.operationId),
      data.operations.listEscalations(operation.operationId),
      data.timers.listTimers(operation.operationId, { status: "SCHEDULED" }),
    ]);
    return {
      operationId: operation.operationId,
      entries: timelineOf(messages, notes, escalations),
      pending: [...timers].sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim)).map(pendingTimerView),
    };
  }),

  documentUrl: firmProcedure.input(z.object({ docVersionId: DocVersionId }).strict()).query(async ({ ctx, input }) => {
    const parsed = parseDocVersionId(input.docVersionId);
    if (parsed === undefined) throw refusal("INVALID", "not a document version id");
    const data = ctx.deps.connector;
    const operation = await data.operations.getOperation(parsed.operationId);
    await ctx.firmScope.assertFirm(operation.firmId);
    const version = await data.documents.getVersion(parsed.operationId, parsed.docType, parsed.versionNo);
    const url = await ctx.deps.documents.sign(version.s3Key, downloadFilename(operation.operationNumber, DOC_TYPE_SHORT[version.docType], version.versionNo));
    ctx.log.info("console.document_url", { operationId: operation.operationId, docVersionId: version.docVersionId });
    return { url, expiresInSec: DOCUMENT_URL_TTL_SECONDS };
  }),
});
