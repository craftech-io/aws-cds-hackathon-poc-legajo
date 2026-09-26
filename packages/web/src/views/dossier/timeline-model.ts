// The unified timeline of an operation and its pendings (docs/design-brief.md §6, row 2; FL-081):
// WhatsApp and email messages, the agent's turn notes and the escalations of `operations.timeline`,
// merged with the decisions of the audit log that no message already shows (milestones fired, rules
// that denied, actions of the firm), all ordered by simulated time (`sentAtSim` / `atSim`). The
// pendings are the operation's SCHEDULED timers with their reason and, for each, how far "Avanzar
// hasta ahí" has to move the paused clock; plus what the world is still waiting for on this operation.
import { type RuleId, isRuleId } from "@legajo/shared";
import type { WorldPending } from "../../lib/world-clock";
import type { DecisionData, EscalationData, MessageData, PendingTimerData, TimelineEntryData } from "./types";

export type TimelineItem =
  | { readonly kind: "MESSAGE"; readonly key: string; readonly atSim: string; readonly message: MessageData }
  | { readonly kind: "NOTE"; readonly key: string; readonly atSim: string; readonly trigger: string; readonly text: string }
  | { readonly kind: "ESCALATION"; readonly key: string; readonly atSim: string; readonly escalation: EscalationData }
  | { readonly kind: "DECISION"; readonly key: string; readonly atSim: string; readonly decision: DecisionData };

/** At the same simulated instant: the decision that led to it, the message, an escalation it opened, the turn's closing note. */
const SAME_INSTANT_ORDER: Readonly<Record<TimelineItem["kind"], number>> = { DECISION: 0, MESSAGE: 1, ESCALATION: 2, NOTE: 3 };

function fromEntry(entry: TimelineEntryData): TimelineItem {
  switch (entry.type) {
    case "MESSAGE":
      return { kind: "MESSAGE", key: `msg:${entry.message.messageId}`, atSim: entry.message.sentAtSim, message: entry.message };
    case "NOTE":
      return { kind: "NOTE", key: `note:${entry.turnId}`, atSim: entry.atSim, trigger: entry.trigger, text: entry.text };
    case "ESCALATION":
      return { kind: "ESCALATION", key: `esc:${entry.escalation.escalationId}`, atSim: entry.atSim, escalation: entry.escalation };
  }
}

/**
 * One list in simulated order. A decision about a message on the timeline is already shown by that
 * message (its policy and rules); a decision with no simulated time happened outside the world.
 */
export function mergeTimeline(entries: readonly TimelineEntryData[], decisions: readonly DecisionData[]): TimelineItem[] {
  const messages = new Set(entries.flatMap((entry) => (entry.type === "MESSAGE" ? [entry.message.messageId] : [])));
  const items: TimelineItem[] = entries.map(fromEntry);
  for (const decision of decisions) {
    if (decision.atSim === undefined) continue;
    if (decision.messageId !== undefined && messages.has(decision.messageId)) continue;
    items.push({ kind: "DECISION", key: `dec:${decision.decisionId}`, atSim: decision.atSim, decision });
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Date.parse(a.item.atSim) - Date.parse(b.item.atSim) || SAME_INSTANT_ORDER[a.item.kind] - SAME_INSTANT_ORDER[b.item.kind] || a.index - b.index)
    .map(({ item }) => item);
}

// ---- Pendings ------------------------------------------------------------------------------------

/** "Avanzar hasta ahí" moves the paused clock by whole minutes, at most 14 days (lib/world-clock.ts). */
export const MAX_ADVANCE_MINUTES = 14 * 24 * 60;

export type AdvanceStep =
  | { readonly kind: "minutes"; readonly minutes: number }
  /** Already due: the next move of the clock fires it. */
  | { readonly kind: "due" }
  /** Beyond what one move of the clock allows. */
  | { readonly kind: "tooFar" }
  /** The world clock has not answered yet. */
  | { readonly kind: "unknown" };

export function advanceStepTo(simNow: string | undefined, dueAtSim: string): AdvanceStep {
  if (simNow === undefined) return { kind: "unknown" };
  const remaining = Date.parse(dueAtSim) - Date.parse(simNow);
  if (remaining <= 0) return { kind: "due" };
  const minutes = Math.ceil(remaining / 60_000);
  return minutes > MAX_ADVANCE_MINUTES ? { kind: "tooFar" } : { kind: "minutes", minutes };
}

/** Why a timer waits: a rule of the contact policy, a known code, or the words its creator wrote. */
export type PendingReason = { readonly kind: "rule"; readonly ruleId: RuleId } | { readonly kind: "code"; readonly code: string } | { readonly kind: "text"; readonly text: string } | { readonly kind: "none" };

const CODE = /^[A-Z][A-Z0-9_]*$/;

export function pendingReasonOf(reason: string | undefined): PendingReason {
  if (reason === undefined || reason.trim() === "") return { kind: "none" };
  if (isRuleId(reason)) return { kind: "rule", ruleId: reason };
  if (CODE.test(reason)) return { kind: "code", code: reason };
  return { kind: "text", text: reason };
}

/** The clock a pending is read in: the supplier's own for a send deferred by its business hours. */
export type PendingZone = "SUPPLIER" | "ARGENTINA";

export interface PendingTimer {
  readonly key: string;
  readonly timer: PendingTimerData;
  readonly reason: PendingReason;
  readonly zone: PendingZone;
  readonly advance: AdvanceStep;
}

export function pendingTimers(timers: readonly PendingTimerData[], simNow: string | undefined): PendingTimer[] {
  return [...timers]
    .sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim))
    .map((timer) => {
      const reason = pendingReasonOf(timer.reason);
      const supplierHours = reason.kind === "rule" && reason.ruleId === "CP-HOURS-SUPPLIER";
      return { key: `${timer.kind}#${timer.timerId}`, timer, reason, zone: supplierHours ? "SUPPLIER" : "ARGENTINA", advance: advanceStepTo(simNow, timer.dueAtSim) };
    });
}

/** What the world waits for on this operation (a turn, a queued event, a mail in transit, a scan). */
export function worldPendingsOf(pending: readonly WorldPending[], operationNumber: string): WorldPending[] {
  return pending.filter((item) => item.operationNumber === operationNumber);
}
