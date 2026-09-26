// `audit` router (docs/tool-catalog.md, FL-086): the decision log of a world (or of one of its
// operations), its policy violations, and the DENY and DEFER decisions counted by rule, which is the
// evidence next to the violations counter. Decisions carry rules, actors and references, never a
// message body or a contact.
import { z } from "zod";
import { AuditDecision, OperationId } from "@legajo/shared";
import type { Connector } from "../connector/index";
import type { Decision } from "../domain/audit";
import { decisionsByRule } from "../metrics/kpis";
import { WorldFields, WorldInput, worldOf } from "./clock";
import { firmProcedure, router } from "./trpc";

/** Most decisions one call returns. */
export const AUDIT_LIST_LIMIT = 200;

const ListInput = WorldFields.extend({
  operationId: OperationId.optional(),
  decision: AuditDecision.optional(),
  limit: z.number().int().positive().max(AUDIT_LIST_LIMIT).default(100),
})
  .strict()
  .prefault({});

function decisionView(decision: Decision) {
  return {
    decisionId: decision.decisionId,
    ts: decision.ts,
    decision: decision.decision,
    action: decision.action,
    ruleIds: decision.ruleIds,
    evaluated: decision.evaluated,
    actor: decision.actor,
    refs: decision.refs,
    ...(decision.operationId === undefined ? {} : { operationId: decision.operationId }),
    ...(decision.messageId === undefined ? {} : { messageId: decision.messageId }),
    ...(decision.trigger === undefined ? {} : { trigger: decision.trigger }),
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.atSim === undefined ? {} : { atSim: decision.atSim }),
    atReal: decision.atReal,
  };
}

async function worldDecisions(data: Connector, firmId: string, clockId: string, kinds: readonly AuditDecision[], limit?: number): Promise<Decision[]> {
  const pages = await Promise.all(kinds.map((kind) => data.audit.listByDecision(firmId, kind)));
  const rows = pages.flat().filter((decision) => decision.clockId === clockId);
  // `ts` is canonical UTC and `decisionId` a ULID: both order as strings.
  const key = (decision: Decision) => `${decision.ts}#${decision.decisionId}`;
  const newestFirst = rows.sort((a, b) => (key(a) < key(b) ? 1 : -1));
  return limit === undefined ? newestFirst : newestFirst.slice(0, limit);
}

export const auditRouter = router({
  list: firmProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const data = ctx.deps.connector;
    const clockId = await worldOf(ctx, input.clockId);
    if (input.operationId !== undefined) {
      const operation = await data.operations.getOperation(input.operationId);
      await ctx.firmScope.assertFirm(operation.firmId);
      const trail = await data.audit.listByOperation(operation.operationId, { descending: true, limit: input.limit });
      const filtered = input.decision === undefined ? trail : trail.filter((decision) => decision.decision === input.decision);
      return { clockId, decisions: filtered.map(decisionView) };
    }
    const kinds = input.decision === undefined ? AuditDecision.options : [input.decision];
    return { clockId, decisions: (await worldDecisions(data, ctx.principal.firmId, clockId, kinds, input.limit)).map(decisionView) };
  }),

  violations: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
    const clockId = await worldOf(ctx, input.clockId);
    const violations = await worldDecisions(ctx.deps.connector, ctx.principal.firmId, clockId, ["VIOLATION"]);
    return { clockId, count: violations.length, violations: violations.map(decisionView) };
  }),

  decisionsByRule: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
    const clockId = await worldOf(ctx, input.clockId);
    const decisions = await worldDecisions(ctx.deps.connector, ctx.principal.firmId, clockId, ["DENY", "DEFER"]);
    return { clockId, byRule: decisionsByRule(decisions) };
  }),
});
