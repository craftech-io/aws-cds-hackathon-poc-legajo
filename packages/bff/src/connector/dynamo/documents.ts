// `Operations/DOC#…`, `DOC#…#V#<nnn>` and `OBS#…`: the three documents, their versions (a new
// version and the document that points to it are one transaction, pinned to the document's
// version) and the observations with their attempts and dated status history.
import { ConnectorError, docVersionId, type DocType } from "@legajo/shared";
import { Document, DocumentVersion, Observation, ObservationEvent, parseDocVersionId } from "../../domain/documents";
import type { TableName } from "../../lib/resource";
import { DOC_PREFIX, OBS_PREFIX, documentKey, observationKey, operationPartition, versionKey, versionPrefix } from "../keys";
import type { DocumentsPort } from "../ports";
import { buildRow, checked, checkPatch, createRow, defined, nowIso, optionalEntity, parseEntities, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Operations";

export function documentsRepo(ctx: RepoContext): DocumentsPort {
  const { client } = ctx;

  const getDocument = async (operationId: string, docType: DocType): Promise<Document> =>
    requireEntity(Document, "Document", await client.get(TABLE, documentKey(operationId, docType)), TABLE, `${docType} of ${operationId}`);

  const getObservation = async (operationId: string, observationId: string): Promise<Observation> =>
    requireEntity(Observation, "Observation", await client.get(TABLE, observationKey(operationId, observationId)), TABLE, `observation ${observationId}`);

  function stale(what: string, expected: number | undefined, actual: number): void {
    if (expected !== undefined && expected !== actual) throw new ConnectorError("CONFLICT", `${what} changed`, TABLE);
  }

  return {
    getDocument,
    getObservation,

    async listDocuments(operationId) {
      const rows = await client.query(TABLE, { hashValue: operationPartition(operationId), range: { prefix: DOC_PREFIX }, filter: { equals: { entity: "Document" } } });
      return parseEntities(Document, "Document", rows, TABLE);
    },

    async updateDocument(operationId, docType, patch, expectedVersion) {
      const fields = checkPatch(Document, patch, TABLE, `${docType} of ${operationId}`);
      const document = await getDocument(operationId, docType);
      stale(`${docType} of ${operationId}`, expectedVersion, document.version);
      return updateRow(ctx, TABLE, Document, "Document", documentKey(operationId, docType), { set: fields }, { condition: { ifVersion: document.version } });
    },

    async addVersion(input) {
      const { version: fields } = input;
      const document = await getDocument(fields.operationId, fields.docType);
      stale(`${fields.docType} of ${fields.operationId}`, input.expectedDocumentVersion, document.version);
      if (fields.versionNo !== document.currentVersion + 1) {
        throw new ConnectorError("CONFLICT", `${fields.docType} of ${fields.operationId} is at version ${document.currentVersion}, not ${fields.versionNo - 1}`, TABLE);
      }
      const id = docVersionId(fields.operationId, fields.docType, fields.versionNo);
      const built = buildRow(ctx, TABLE, DocumentVersion, "DocumentVersion", versionKey(fields.operationId, fields.docType, fields.versionNo), { ...fields, docVersionId: id });
      const documentPatch = input.document === undefined ? {} : checkPatch(Document, input.document, TABLE, `${fields.docType} of ${fields.operationId}`);
      const set = { ...documentPatch, currentVersion: fields.versionNo, currentDocVersionId: id, receivedAtSim: fields.receivedAtSim };
      await client.transact([
        { op: "put", table: TABLE, item: built.item, condition: { ifNotExists: true } },
        { op: "update", table: TABLE, key: documentKey(fields.operationId, fields.docType), spec: { set }, updatedAt: nowIso(ctx), options: { condition: { ifVersion: document.version } } },
      ]);
      return { version: built.value, document: await getDocument(fields.operationId, fields.docType) };
    },

    async getVersion(operationId, docType, versionNo) {
      return requireEntity(DocumentVersion, "DocumentVersion", await client.get(TABLE, versionKey(operationId, docType, versionNo)), TABLE, `version ${versionNo} of ${docType}`);
    },

    async findVersion(id) {
      const parsed = parseDocVersionId(id);
      if (!parsed) return undefined;
      return optionalEntity(DocumentVersion, "DocumentVersion", await client.get(TABLE, versionKey(parsed.operationId, parsed.docType, parsed.versionNo)), TABLE);
    },

    async listVersions(operationId, docType) {
      const prefix = docType === undefined ? DOC_PREFIX : versionPrefix(docType);
      const rows = await client.query(TABLE, { hashValue: operationPartition(operationId), range: { prefix }, filter: { equals: { entity: "DocumentVersion" } } });
      return parseEntities(DocumentVersion, "DocumentVersion", rows, TABLE);
    },

    async updateVersion(operationId, docType, versionNo, patch, expectedVersion) {
      const fields = checkPatch(DocumentVersion, patch, TABLE, `version ${versionNo} of ${docType}`);
      const key = versionKey(operationId, docType, versionNo);
      const version = requireEntity(DocumentVersion, "DocumentVersion", await client.get(TABLE, key), TABLE, `version ${versionNo} of ${docType}`);
      stale(`version ${versionNo} of ${docType}`, expectedVersion, version.version);
      return updateRow(ctx, TABLE, DocumentVersion, "DocumentVersion", key, { set: fields }, { condition: { ifVersion: version.version } });
    },

    async listObservations(operationId, options = {}) {
      const rows = await client.query(TABLE, { hashValue: operationPartition(operationId), range: { prefix: OBS_PREFIX } });
      const observations = parseEntities(Observation, "Observation", rows, TABLE);
      return observations.filter((observation) => (options.docType === undefined || observation.docType === options.docType) && (options.statuses === undefined || options.statuses.includes(observation.status)));
    },

    async findObservation(operationId, observationId) {
      return optionalEntity(Observation, "Observation", await client.get(TABLE, observationKey(operationId, observationId)), TABLE);
    },

    async createObservation(input) {
      const { created, ...observation } = input;
      const first = checked(ObservationEvent, TABLE, defined({ ...created, status: observation.status, docVersionId: observation.lastDocVersionId }));
      return createRow(ctx, TABLE, Observation, "Observation", observationKey(observation.operationId, observation.observationId), { ...observation, history: [first] });
    },

    async updateObservation(operationId, observationId, patch, expectedVersion) {
      const fields = checkPatch(Observation, patch, TABLE, `observation ${observationId}`);
      const observation = await getObservation(operationId, observationId);
      stale(`observation ${observationId}`, expectedVersion, observation.version);
      return updateRow(ctx, TABLE, Observation, "Observation", observationKey(operationId, observationId), { set: fields }, { condition: { ifVersion: observation.version } });
    },

    async transitionObservation(transition) {
      const observation = await getObservation(transition.operationId, transition.observationId);
      stale(`observation ${transition.observationId}`, transition.expectedVersion, observation.version);
      const patch = transition.patch === undefined ? {} : checkPatch(Observation, transition.patch, TABLE, `observation ${transition.observationId}`);
      const event = checked(ObservationEvent, TABLE, defined({ atSim: transition.atSim, atReal: transition.atReal, by: transition.by, reason: transition.reason, status: transition.to, docVersionId: transition.docVersionId }));
      const set = { ...patch, status: transition.to, ...(transition.docVersionId === undefined ? {} : { lastDocVersionId: transition.docVersionId }) };
      return updateRow(
        ctx,
        TABLE,
        Observation,
        "Observation",
        observationKey(transition.operationId, transition.observationId),
        { set, append: { history: [event] }, ...(transition.countAttempt ? { add: { attempts: 1 } } : {}) },
        { condition: { ifVersion: observation.version } },
      );
    },
  };
}
