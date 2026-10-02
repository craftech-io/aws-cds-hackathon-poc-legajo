// An `AGENT_TURN` (docs/architecture.md §7 and §9.1, docs/design-brief.md §5.1): the gates every turn
// passes before the Harness, in this order, and then the invocation (turns/invoke.ts).
//
//   1. the operation exists in the event's world (a reset or a destroyed world leaves late events behind)
//   2. `control = BROKER` → no turn: `TURN_SKIPPED_CONTROL_BROKER` (`CP-CONTROL-BROKER`, FL-069); the
//      event stays on the timeline and its PDFs went through their own intake
//   3. the quota of a guest world and the firm's turn caps (worker/turn-cap.ts) → `TURN_QUOTA` with its
//      note, or `TURN_CAP`; no turn and no outbound
//   4. the G1 pre-filter over the turn's untrusted text, if a party wrote it (turns/prefilter.ts): only a
//      BLOCKED assessment blocks (worker/guardrail-block.ts) and the Harness is not invoked; an
//      anonymization goes on with G1's text, masked again by the normalizer, and `GUARDRAIL_MASK`
//
// Every decision is audited once per event, so a retried event never doubles a row.
import { countMetric } from "../channels/adapter";
import { normalizeInboundText } from "../channels/normalizer";
import type { Operation } from "../domain/operations";
import { WORKER_ACTIONS, type WorkerDecision, auditOnce } from "../worker/audit";
import type { TurnEvent } from "../worker/events";
import { handleGuardrailBlock } from "../worker/guardrail-block";
import type { WorkerContext } from "../worker/ports";
import { type TurnBudget, checkTurnBudget } from "../worker/turn-cap";
import type { TurnDeps, TurnOutcome } from "./deps";
import { type TurnInbound, loadInbound } from "./envelope";
import { invokeTurn } from "./invoke";
import { FIXED_NOTES, writeTurnNote } from "./record";

export const TURN_CAP_METRIC = "TurnCapHits";

export type TurnContext = WorkerContext & { readonly deadlineMs: number };

function decisionBase(event: TurnEvent, operation: Operation, ctx: WorkerContext): Omit<WorkerDecision, "action"> {
  return {
    eventId: event.eventId,
    firmId: operation.firmId,
    clockId: operation.clockId,
    operationId: operation.operationId,
    atSim: event.eventAtSim,
    atReal: ctx.now().toISOString(),
    trigger: event.trigger,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
  };
}

/** The note and the audit of a turn the budget refused. */
async function refuseByBudget(deps: TurnDeps, ctx: WorkerContext, event: TurnEvent, operation: Operation, budget: Exclude<TurnBudget, { allowed: true }>): Promise<TurnOutcome> {
  const base = decisionBase(event, operation, ctx);
  if (budget.refusal === "TURN_QUOTA") {
    await writeTurnNote({ data: deps.data, agentMode: deps.agentMode, now: ctx.now, log: ctx.log }, { operation, event, turnId: `quota-${event.eventId}`, text: FIXED_NOTES.quota });
    await auditOnce(deps.data.audit, { ...base, action: WORKER_ACTIONS.turnQuota, detail: { kind: budget.kind, resetsAtReal: budget.resetsAtReal } });
    return { kind: "SKIPPED", reason: "TURN_QUOTA" };
  }
  await auditOnce(deps.data.audit, { ...base, action: WORKER_ACTIONS.turnCap, detail: { window: budget.window, count: budget.count, cap: budget.cap } });
  countMetric(ctx.log, TURN_CAP_METRIC, { firmId: operation.firmId, window: budget.window });
  return { kind: "SKIPPED", reason: "TURN_CAP" };
}

/** G1 over a party's text: a block ends the turn here; an anonymization replaces the text. */
async function prefilter(deps: TurnDeps, ctx: WorkerContext, event: TurnEvent, operation: Operation, inbound: TurnInbound): Promise<{ readonly blocked: TurnOutcome } | { readonly inbound: TurnInbound }> {
  if (inbound.source === "SYSTEM") return { inbound };
  const verdict = await deps.prefilter.check(inbound.text);
  if (verdict.action === "NONE") return { inbound };
  if (verdict.action === "BLOCKED") {
    const outcome = await handleGuardrailBlock(
      { data: deps.data, escalation: deps.escalation, sink: ctx.sink, log: ctx.log, now: ctx.now },
      { event, operation, block: { origin: "PREFILTER", source: inbound.source, policy: verdict.policy, topics: verdict.topics }, ...(inbound.message === undefined ? {} : { message: inbound.message }) },
    );
    return { blocked: { kind: "BLOCKED", origin: "PREFILTER", escalationId: outcome.escalationId } };
  }
  const masked = normalizeInboundText(verdict.text);
  await auditOnce(deps.data.audit, {
    ...decisionBase(event, operation, ctx),
    action: WORKER_ACTIONS.guardrailMask,
    ruleIds: ["G1"],
    refs: inbound.message === undefined ? {} : { messageId: inbound.message.messageId },
    detail: { kinds: [...verdict.kinds], source: inbound.source },
  });
  return { inbound: { ...inbound, text: masked.text, truncated: inbound.truncated || masked.truncated } };
}

export async function runAgentTurn(deps: TurnDeps, event: TurnEvent, ctx: TurnContext): Promise<TurnOutcome> {
  const operation = await deps.data.operations.findOperation(event.operationId);
  if (operation === undefined || operation.clockId !== event.clockId || operation.firmId !== event.firmId) {
    ctx.log.warn("turn.operation_gone", { operationId: event.operationId, trigger: event.trigger });
    return { kind: "SKIPPED", reason: "NO_OPERATION" };
  }
  if (operation.control === "BROKER") {
    await auditOnce(deps.data.audit, { ...decisionBase(event, operation, ctx), action: WORKER_ACTIONS.skippedControl, ruleIds: ["CP-CONTROL-BROKER"], ...(event.messageId === undefined ? {} : { refs: { messageId: event.messageId } }) });
    return { kind: "SKIPPED", reason: "CONTROL_BROKER" };
  }
  const budget = await checkTurnBudget({ data: deps.data, consumeTurnQuota: deps.consumeTurnQuota, now: ctx.now, log: ctx.log }, operation);
  if (!budget.allowed) return refuseByBudget(deps, ctx, event, operation, budget);
  let inbound = await loadInbound(deps.data, event, operation);
  if (inbound !== undefined) {
    const filtered = await prefilter(deps, ctx, event, operation, inbound);
    if ("blocked" in filtered) return filtered.blocked;
    inbound = filtered.inbound;
  }
  return invokeTurn(deps, ctx, { operation, event, ...(inbound === undefined ? {} : { inbound }) });
}
