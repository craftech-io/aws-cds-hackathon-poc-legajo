// `Operations/META`: the operation, created together with its three documents and its thread claim;
// dossier, control, ETA and dispatch transitions, each pinned to the version it read and appending
// its dated history in the same UpdateItem (docs/architecture.md §5, "Reglas de escritura"). GSI1
// (`FIRM#<firmId>#<status>` + ETA) and GSI2 (`THREAD#<number>-<tag>`) move with the row.
import { ConnectorError, DocType, DossierStatus, threadAddress } from "@legajo/shared";
import { utcInstant } from "../../domain/common";
import { Document } from "../../domain/documents";
import { ControlEvent, DispatchEvent, DossierEvent, EtaEvent, Operation, canTransitionDossier } from "../../domain/operations";
import type { TableName } from "../../lib/resource";
import { expectedIndexAttributes } from "../item-shape";
import { documentKey, firmStatusKey, operationKey, threadKey } from "../keys";
import type { IdentityLookup, OperationsPort } from "../ports";
import type { TransactOp } from "../table-client";
import { claimRow } from "./address-claims";
import { escalationsRepo } from "./escalations";
import { buildRow, checked, checkPatch, defined, optionalEntity, parseEntities, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Operations";

export function operationsRepo(ctx: RepoContext): OperationsPort {
  const { client } = ctx;

  const getOperation = async (operationId: string): Promise<Operation> =>
    requireEntity(Operation, "Operation", await client.get(TABLE, operationKey(operationId)), TABLE, `operation ${operationId}`);

  /** The current row, refused when the caller read an older version. */
  async function current(operationId: string, expectedVersion: number | undefined): Promise<Operation> {
    const operation = await getOperation(operationId);
    if (expectedVersion !== undefined && expectedVersion !== operation.version) throw new ConnectorError("CONFLICT", `operation ${operationId} changed`, TABLE);
    return operation;
  }

  const pinned = (operation: Operation) => ({ condition: { ifVersion: operation.version } });

  return {
    getOperation,
    ...escalationsRepo(ctx, getOperation),

    async findOperation(operationId) {
      return optionalEntity(Operation, "Operation", await client.get(TABLE, operationKey(operationId)), TABLE);
    },

    async findOperationByThread(operationNumber, threadTag): Promise<IdentityLookup<Operation>> {
      const rows = await client.query(TABLE, { index: "GSI2", hashValue: threadKey(operationNumber, threadTag), filter: { equals: { entity: "Operation" } }, limit: 2 });
      const operations = parseEntities(Operation, "Operation", rows, TABLE);
      const [first] = operations;
      if (!first) return { status: "NONE" };
      return operations.length === 1 ? { status: "UNIQUE", value: first } : { status: "AMBIGUOUS", ids: operations.map((operation) => operation.operationId) };
    },

    async listOperations(firmId, options = {}) {
      const statuses = options.statuses ?? DossierStatus.options;
      const equals: Record<string, string> = { entity: "Operation" };
      if (options.importerId !== undefined) equals.importerId = options.importerId;
      if (options.clockId !== undefined) equals.clockId = options.clockId;
      const pages = await Promise.all(statuses.map((status) => client.query(TABLE, { index: "GSI1", hashValue: firmStatusKey(firmId, status), filter: { equals } })));
      return parseEntities(Operation, "Operation", pages.flat(), TABLE).sort((a, b) => Date.parse(a.eta) - Date.parse(b.eta) || (a.operationId < b.operationId ? -1 : 1));
    },

    async createOperation(input) {
      const { created, etaSource, documents = {}, threadClaimHash, ...operation } = input;
      if (threadAddress(operation.operationNumber, operation.threadTag) !== operation.threadAddress) {
        throw new ConnectorError("VALIDATION", `thread address of ${operation.operationId} does not match its number and tag`, TABLE);
      }
      const fields = {
        ...operation,
        etaHistory: [checked(EtaEvent, TABLE, defined({ eta: operation.eta, atSim: created.atSim, atReal: created.atReal, source: etaSource }))],
        dossierHistory: [checked(DossierEvent, TABLE, defined({ ...created, status: operation.dossierStatus }))],
        controlHistory: [checked(ControlEvent, TABLE, defined({ ...created, control: operation.control }))],
      };
      const built = buildRow(ctx, TABLE, Operation, "Operation", operationKey(operation.operationId), fields, { gsi: expectedIndexAttributes("Operation", operation) });
      const ops: TransactOp[] = [{ op: "put", table: TABLE, item: built.item, condition: { ifNotExists: true } }];
      for (const docType of DocType.options) {
        const doc = buildRow(ctx, TABLE, Document, "Document", documentKey(operation.operationId, docType), {
          operationId: operation.operationId,
          clockId: operation.clockId,
          docType,
          status: documents[docType] ?? "MISSING",
          currentVersion: 0,
        });
        ops.push({ op: "put", table: TABLE, item: doc.item, condition: { ifNotExists: true } });
      }
      if (threadClaimHash !== undefined) {
        const claim = claimRow(ctx, { addressHash: threadClaimHash, kind: "THREAD", ownerType: "OPERATION", ownerId: operation.operationId, firmId: operation.firmId, clockId: operation.clockId });
        ops.push({ op: "put", table: "Parties", item: claim, condition: { ifNotExists: true } });
      }
      await client.transact(ops);
      return built.value;
    },

    async updateOperation(operationId, patch, expectedVersion) {
      const fields = checkPatch(Operation, patch, TABLE, `operation ${operationId}`);
      const operation = await current(operationId, expectedVersion);
      return updateRow(ctx, TABLE, Operation, "Operation", operationKey(operationId), { set: fields }, pinned(operation));
    },

    async transitionDossier(transition) {
      const operation = await current(transition.operationId, transition.expectedVersion);
      if (!canTransitionDossier(operation.dossierStatus, transition.to)) {
        throw new ConnectorError("VALIDATION", `dossier of ${transition.operationId} cannot go from ${operation.dossierStatus} to ${transition.to}`, TABLE);
      }
      if ((transition.to === "APPROVED") !== (transition.approvedBy !== undefined)) throw new ConnectorError("VALIDATION", "an approval, and only an approval, names its broker", TABLE);
      const event = checked(DossierEvent, TABLE, defined({ atSim: transition.atSim, atReal: transition.atReal, by: transition.by, reason: transition.reason, status: transition.to }));
      const set: Record<string, unknown> = { dossierStatus: transition.to, firmStatusKey: firmStatusKey(operation.firmId, transition.to) };
      if (transition.to === "APPROVED") Object.assign(set, { approvedBy: transition.approvedBy, approvedAtSim: transition.atSim });
      return updateRow(ctx, TABLE, Operation, "Operation", operationKey(transition.operationId), { set, append: { dossierHistory: [event] } }, pinned(operation));
    },

    async setControl(change) {
      const operation = await current(change.operationId, change.expectedVersion);
      if (operation.control === change.control) return operation;
      const event = checked(ControlEvent, TABLE, defined({ atSim: change.atSim, atReal: change.atReal, by: change.by, reason: change.reason, control: change.control }));
      return updateRow(ctx, TABLE, Operation, "Operation", operationKey(change.operationId), { set: { control: change.control }, append: { controlHistory: [event] } }, pinned(operation));
    },

    // A carrier event delivered twice (same `eventId`) changes the ETA once.
    async changeEta(change) {
      const operation = await current(change.operationId, change.expectedVersion);
      if (change.eventId !== undefined && operation.etaHistory.some((entry) => entry.eventId === change.eventId)) return operation;
      const event = checked(EtaEvent, TABLE, defined({ eta: change.eta, previousEta: operation.eta, atSim: change.atSim, atReal: change.atReal, source: change.source, eventId: change.eventId }));
      return updateRow(ctx, TABLE, Operation, "Operation", operationKey(change.operationId), { set: { eta: change.eta, etaSort: utcInstant(change.eta) }, append: { etaHistory: [event] } }, pinned(operation));
    },

    async recordDispatch(change) {
      const operation = await current(change.operationId, change.expectedVersion);
      if (change.eventId !== undefined && operation.dispatch.history.some((entry) => entry.eventId === change.eventId)) return operation;
      const event = checked(DispatchEvent, TABLE, defined({ status: change.status, channel: change.channel, occurredAtSim: change.occurredAtSim, eventId: change.eventId }));
      const dispatch = defined({ status: change.status, channel: change.channel, occurredAtSim: change.occurredAtSim, history: [...operation.dispatch.history, event] });
      return updateRow(ctx, TABLE, Operation, "Operation", operationKey(change.operationId), { set: { dispatch } }, pinned(operation));
    },

    async nextSessionEpoch(operationId) {
      const updated = await updateRow(ctx, TABLE, Operation, "Operation", operationKey(operationId), { add: { sessionEpoch: 1 } });
      return updated.sessionEpoch;
    },
  };
}
