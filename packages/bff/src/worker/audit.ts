// The worker's own decisions in `AuditLog` (docs/architecture.md §7 and §9.1): turns skipped by the
// firm's control, turns refused by a cap or a quota, guardrail blocks and masks, failed turns and
// dead-lettered events. Each one is written at most once per event (`recordOnce`, keyed by the event
// id and the action), so a retried event never doubles a row. Actor `SYSTEM`: the deterministic code
// decided, not the agent.
import type { RuleId } from "@legajo/shared";
import type { AuditPort } from "../connector/index";
import type { JsonObject } from "../domain/common";
import type { DecisionRefs } from "../domain/audit";

/** Actions the worker writes (labelled by the console in views/dossier/labels.ts and views/audit/copy.ts). */
export const WORKER_ACTIONS = {
  skippedControl: "TURN_SKIPPED_CONTROL_BROKER",
  turnCap: "TURN_CAP",
  turnQuota: "TURN_QUOTA",
  guardrailBlock: "GUARDRAIL_BLOCK",
  guardrailMask: "GUARDRAIL_MASK",
  turnFailed: "TURN_FAILED",
  deadLettered: "EVENT_DEAD_LETTERED",
} as const;
export type WorkerAction = (typeof WORKER_ACTIONS)[keyof typeof WORKER_ACTIONS];

export interface WorkerDecision {
  readonly action: WorkerAction;
  readonly eventId: string;
  readonly firmId: string;
  readonly clockId: string;
  readonly operationId: string;
  /** Simulated instant of the event: the decision's place in the operation's timeline. */
  readonly atSim: string;
  readonly atReal: string;
  readonly trigger?: string;
  readonly ruleIds?: readonly RuleId[];
  readonly refs?: Omit<DecisionRefs, "operationId" | "eventId">;
  readonly reason?: string;
  readonly detail?: JsonObject;
  readonly correlationId?: string;
}

/** Writes the decision once per event and action; a repeat returns `false` and writes nothing. */
export async function auditOnce(audit: Pick<AuditPort, "recordOnce">, decision: WorkerDecision): Promise<boolean> {
  const { recorded } = await audit.recordOnce(`${decision.action}#${decision.eventId}`, {
    firmId: decision.firmId,
    decision: "ACTION",
    action: decision.action,
    ruleIds: [...(decision.ruleIds ?? [])],
    actor: "SYSTEM",
    refs: { ...decision.refs, operationId: decision.operationId, eventId: decision.eventId },
    clockId: decision.clockId,
    operationId: decision.operationId,
    atSim: decision.atSim,
    atReal: decision.atReal,
    ...(decision.trigger === undefined ? {} : { trigger: decision.trigger }),
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.detail === undefined ? {} : { detail: decision.detail }),
    ...(decision.correlationId === undefined ? {} : { correlationId: decision.correlationId }),
  });
  return recorded;
}
