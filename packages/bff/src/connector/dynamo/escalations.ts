// `Operations/ESC#<escalationId>`: at most one OPEN escalation per reason and operation (a second
// call returns the open one, docs/tool-catalog.md `escalate_to_broker`). Ids are deterministic per
// reason (`esc-<reason>-<n>`) and created with `attribute_not_exists`, so two concurrent openings of
// the same reason cannot both win.
import { ConnectorError, DossierStatus } from "@legajo/shared";
import { Escalation, type EscalationId } from "../../domain/operations";
import type { Operation } from "../../domain/operations";
import type { TableName } from "../../lib/resource";
import { ESC_PREFIX, escalationKey, firmStatusKey, operationPartition } from "../keys";
import type { OperationsPort } from "../ports";
import { createRow, nowIso, parseEntities, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Operations";

type EscalationMethods = Pick<OperationsPort, "openEscalation" | "getEscalation" | "listEscalations" | "listOpenEscalationsByFirm" | "markEscalationEmailed" | "resolveEscalation">;

/** `esc-missing-at-eta-48h-1`: the n-th escalation of that reason in the operation. */
export function escalationIdFor(reason: Escalation["reason"], n: number): EscalationId {
  return `esc-${reason.toLowerCase().replaceAll("_", "-")}-${n}`;
}

export function escalationsRepo(ctx: RepoContext, getOperation: (operationId: string) => Promise<Operation>): EscalationMethods {
  const { client } = ctx;

  async function list(operationId: string, status?: Escalation["status"]): Promise<Escalation[]> {
    const rows = await client.query(TABLE, { hashValue: operationPartition(operationId), range: { prefix: ESC_PREFIX }, ...(status ? { filter: { equals: { status } } } : {}) });
    return parseEntities(Escalation, "Escalation", rows, TABLE);
  }

  const getEscalation = async (operationId: string, escalationId: string): Promise<Escalation> =>
    requireEntity(Escalation, "Escalation", await client.get(TABLE, escalationKey(operationId, escalationId)), TABLE, `escalation ${escalationId}`);

  return {
    getEscalation,

    async listEscalations(operationId, options = {}) {
      return list(operationId, options.status);
    },

    async openEscalation(input) {
      const operation = await getOperation(input.operationId);
      if (operation.firmId !== input.firmId || operation.clockId !== input.clockId) throw new ConnectorError("VALIDATION", `escalation does not match operation ${input.operationId}`, TABLE);
      const sameReason = (await list(input.operationId)).filter((escalation) => escalation.reason === input.reason);
      const open = sameReason.find((escalation) => escalation.status === "OPEN");
      if (open) return { escalation: open, created: false };
      const escalationId = escalationIdFor(input.reason, sameReason.length + 1);
      try {
        const escalation = await createRow(ctx, TABLE, Escalation, "Escalation", escalationKey(input.operationId, escalationId), {
          openedAtReal: nowIso(ctx),
          ...input,
          escalationId,
          status: "OPEN",
        });
        return { escalation, created: true };
      } catch (error) {
        // Someone opened the same reason in between: theirs is the open one.
        if (!(error instanceof ConnectorError) || error.code !== "CONFLICT") throw error;
        const winner = (await list(input.operationId, "OPEN")).find((escalation) => escalation.reason === input.reason);
        if (!winner) throw error;
        return { escalation: winner, created: false };
      }
    },

    // The console tray: open escalations of every operation of the firm (N + 1 queries over a
    // firm's few dozen operations; no GSI is spent on it).
    async listOpenEscalationsByFirm(firmId) {
      const pages = await Promise.all(DossierStatus.options.map((status) => client.query(TABLE, { index: "GSI1", hashValue: firmStatusKey(firmId, status), filter: { equals: { entity: "Operation" } } })));
      const operationIds = pages.flat().map((row) => String(row.operationId));
      const escalations = await Promise.all(operationIds.map((operationId) => list(operationId, "OPEN")));
      return escalations.flat().sort((a, b) => Date.parse(a.openedAtSim) - Date.parse(b.openedAtSim));
    },

    async markEscalationEmailed(operationId, escalationId) {
      return updateRow(ctx, TABLE, Escalation, "Escalation", escalationKey(operationId, escalationId), { set: { emailSent: true } });
    },

    async resolveEscalation(resolution) {
      const escalation = await getEscalation(resolution.operationId, resolution.escalationId);
      if (resolution.expectedVersion !== undefined && resolution.expectedVersion !== escalation.version) throw new ConnectorError("CONFLICT", `escalation ${resolution.escalationId} changed`, TABLE);
      if (escalation.status !== "OPEN") throw new ConnectorError("CONFLICT", `escalation ${resolution.escalationId} is already resolved`, TABLE);
      return updateRow(
        ctx,
        TABLE,
        Escalation,
        "Escalation",
        escalationKey(resolution.operationId, resolution.escalationId),
        { set: { status: "RESOLVED", resolvedAtSim: resolution.atSim, resolvedBy: resolution.by, resolution: resolution.resolution } },
        { condition: { ifVersion: escalation.version, equals: { status: "OPEN" } } },
      );
    },
  };
}
