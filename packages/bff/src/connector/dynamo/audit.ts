// `AuditLog`: append-only decisions (`attribute_not_exists`, never updated), partitioned by firm and
// month of `ts`. `ts` is the simulated instant of the decision when it belongs to a world (so the
// console's timeline and the month partition follow the story) and the real one otherwise; the
// ULID after it keeps two decisions of the same instant apart and in write order. A decision recorded
// once per key (`recordOnce`) takes a deterministic id instead, so its row key never changes.
import { ConnectorError } from "@legajo/shared";
import { utcInstant } from "../../domain/common";
import { AUDIT_TTL_SECONDS, Decision } from "../../domain/audit";
import { sha256Hex } from "../../lib/crypto";
import type { TableName } from "../../lib/resource";
import { expectedIndexAttributes } from "../item-shape";
import { auditKey, auditPartition, decisionKey, opAuditKey } from "../keys";
import type { AuditPort, DecisionInput } from "../ports-runtime";
import type { RangeCondition } from "../table-client";
import { createRow, parseEntities, type RepoContext } from "./repo";

const TABLE: TableName = "AuditLog";

/** Deterministic id of a decision recorded once per key (never a ULID: those sort by write time). */
export function onceDecisionId(onceKey: string): string {
  return `once-${sha256Hex(onceKey).slice(0, 40)}`;
}

/** Range on the GSIs' `ts`, both ends inclusive. */
function rangeOf(from: string | undefined, to: string | undefined): RangeCondition | undefined {
  const low = from === undefined ? undefined : utcInstant(from);
  const high = to === undefined ? undefined : utcInstant(to);
  if (low !== undefined && high !== undefined) return { between: [low, high] };
  if (low !== undefined) return { gte: low };
  if (high !== undefined) return { lte: high };
  return undefined;
}

export function auditRepo(ctx: RepoContext): AuditPort {
  const { client } = ctx;

  function write(input: DecisionInput, decisionId: string): Promise<Decision> {
    const ts = utcInstant(input.atSim ?? input.atReal);
    const operationId = input.operationId ?? input.refs?.operationId;
    const fields = { ...input, ...(operationId === undefined ? {} : { operationId }), decisionId, ts, month: ts.slice(0, 7) };
    return createRow(ctx, TABLE, Decision, "Decision", auditKey(input.firmId, ts, decisionId), fields, { gsi: expectedIndexAttributes("Decision", fields), ttlSeconds: AUDIT_TTL_SECONDS });
  }

  return {
    record(input) {
      return write(input, ctx.newId());
    },

    async recordOnce(onceKey, input) {
      try {
        await write(input, onceDecisionId(onceKey));
        return { recorded: true };
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONFLICT") return { recorded: false };
        throw error;
      }
    },

    async listByOperation(operationId, options = {}) {
      const range = rangeOf(options.from, options.to);
      const rows = await client.query(TABLE, {
        index: "GSI1",
        hashValue: opAuditKey(operationId),
        ...(range ? { range } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.descending ? { descending: true } : {}),
      });
      return parseEntities(Decision, "Decision", rows, TABLE);
    },

    async listByDecision(firmId, decision, options = {}) {
      const range = rangeOf(options.from, options.to);
      const rows = await client.query(TABLE, {
        index: "GSI2",
        hashValue: decisionKey(firmId, decision),
        ...(range ? { range } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return parseEntities(Decision, "Decision", rows, TABLE);
    },

    async listByMonth(firmId, month) {
      const rows = await client.query(TABLE, { hashValue: auditPartition(firmId, month) });
      return parseEntities(Decision, "Decision", rows, TABLE);
    },

    async findAllowForMessage(operationId, messageId) {
      const rows = await client.query(TABLE, { index: "GSI1", hashValue: opAuditKey(operationId), filter: { equals: { decision: "ALLOW", messageId } }, limit: 1 });
      return parseEntities(Decision, "Decision", rows, TABLE)[0];
    },
  };
}
