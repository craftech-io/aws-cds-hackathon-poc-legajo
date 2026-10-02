// Invariants 10 and 21 of docs/seed-spec.md §15. Invariant 10: every seeded outbound message has its
// `ALLOW` decision with the rules evaluated (PolicyAudit check a), a deferred one has its fired
// `TIMER#DEFERRED_SEND`, and the real contact policy (packages/bff/src/policy/, `evaluateAsOf`, with
// each party's zone and the holidays of `Reference`) decided at the instant the message went out would
// have let it out (check b). Invariant 21: the window of the guest's tour holds no event of another
// operation, and no dossier ready for review or approved has a milestone still scheduled.
import { evaluateAsOf, type AsOfFacts } from "@legajo/bff/policy/as-of";
import { wentOut } from "@legajo/bff/policy/kinds";
import type { PolicyDecision } from "@legajo/bff/policy/types";
import { START_AT_SIM, TOUR_OPERATION_ID, TOUR_WINDOW_END_SIM } from "../lib/constants";
import type { SeedItem } from "../lib/items";
import { str, type WorldView } from "./world-view";

export interface MessageVerdict {
  readonly messageId: string;
  readonly operationId: string;
  readonly decision: PolicyDecision;
  /** Rules that could not be decided for lack of a fact the seed should have provided. */
  readonly undecided: readonly string[];
}

type HistoryRow = NonNullable<AsOfFacts["history"]>[number];

function historyRow(message: SeedItem): HistoryRow {
  return message as unknown as HistoryRow;
}

/** The facts `PolicyAudit` would rebuild for one stored message. */
export function factsOf(view: WorldView, message: SeedItem, holidays: readonly string[]): AsOfFacts {
  const operation = view.find("Operation", (item) => item.operationId === message.operationId);
  if (operation === undefined) throw new RangeError(`${view.label}: message ${str(message.messageId)} of an unknown operation`);
  const importerId = str(operation.importerId);
  const supplierId = str(operation.supplierId);
  const allow = view.find("Decision", (item) => item.messageId === message.messageId && item.decision === "ALLOW");
  const detail = (allow?.detail ?? {}) as Record<string, unknown>;
  const toImporter = message.counterpart === "IMPORTER";
  const counterpartMessages = view.of("Message").filter((other) => (toImporter ? other.counterpart === "IMPORTER" && other.importerId === importerId : other.counterpart === "SUPPLIER" && other.contactId === message.contactId));
  const supplier = view.find("Supplier", (item) => item.supplierId === supplierId);
  const contact = message.contactId === undefined ? undefined : view.find("SupplierContact", (item) => item.contactId === message.contactId);
  const importer = view.find("Importer", (item) => item.importerId === importerId);
  const consent = view.find("Consent", (item) => item.importerId === importerId);
  const authorization = view.find("SupplierAuthorization", (item) => item.importerId === importerId && item.supplierId === supplierId);
  return {
    message: message as unknown as AsOfFacts["message"],
    ...(typeof allow?.trigger === "string" ? { trigger: allow.trigger } : {}),
    ...(typeof detail.answers === "string" ? { answers: detail.answers } : {}),
    operation: operation as unknown as AsOfFacts["operation"],
    ...(importer === undefined ? {} : { importer: importer as unknown as NonNullable<AsOfFacts["importer"]> }),
    ...(consent === undefined ? {} : { consent: consent as unknown as NonNullable<AsOfFacts["consent"]> }),
    ...(authorization === undefined ? {} : { authorization: authorization as unknown as NonNullable<AsOfFacts["authorization"]> }),
    ...(contact === undefined ? {} : { contact: contact as unknown as NonNullable<AsOfFacts["contact"]> }),
    ...(supplier === undefined ? {} : { supplier: supplier as unknown as NonNullable<AsOfFacts["supplier"]> }),
    holidays: [...holidays],
    history: counterpartMessages.map(historyRow),
  };
}

/** What only exists at send time and is not rebuilt from a stored email: the SES client's fence. */
const NOT_REBUILT_BY_DESIGN = new Set(["CP-RECIPIENT-FENCE"]);

/** The real policy over every seeded outbound message of the view. */
export function decideHistory(view: WorldView, holidays: readonly string[]): MessageVerdict[] {
  return view
    .of("Message")
    .filter((message) => wentOut(message as unknown as Parameters<typeof wentOut>[0]))
    .map((message) => {
      const decision = evaluateAsOf(factsOf(view, message, holidays), { exhaustive: true });
      const undecided = decision.evaluated.filter((entry) => entry.detail.endsWith("is not rebuilt for a past instant") && !(message.channel === "EMAIL" && NOT_REBUILT_BY_DESIGN.has(entry.ruleId))).map((entry) => entry.ruleId);
      return { messageId: str(message.messageId), operationId: str(message.operationId), decision, undecided };
    });
}

/**
 * A deferred message went out at the hour the policy lets it out: decided at the instant it was first
 * decided, the policy defers it, and `nextAllowedAt` is exactly its `sentAtSim`.
 */
export function deferralProblems(view: WorldView, message: SeedItem, decidedAtSim: string, holidays: readonly string[]): string[] {
  const facts = factsOf(view, message, holidays);
  const decision = evaluateAsOf({ ...facts, message: { ...facts.message, sentAtSim: decidedAtSim } });
  const id = str(message.messageId);
  if (decision.outcome !== "DEFER") return [`${view.label}: ${id} was deferred at ${decidedAtSim} but the policy says ${decision.outcome} there`];
  if (Date.parse(decision.nextAllowedAt ?? "") !== Date.parse(str(message.sentAtSim))) return [`${view.label}: ${id} went out at ${str(message.sentAtSim)}, the policy lets it out at ${decision.nextAllowedAt ?? "?"}`];
  return [];
}

/** Invariant 10 for one world: decisions recorded, deferrals fired, the policy allows every send. */
export function historyProblems(view: WorldView, holidays: readonly string[]): string[] {
  const problems: string[] = [];
  for (const message of view.of("Message").filter((item) => item.direction === "OUT")) {
    const id = str(message.messageId);
    const allow = view.find("Decision", (item) => item.messageId === id && item.decision === "ALLOW");
    if (allow === undefined || !Array.isArray(allow.evaluated) || allow.evaluated.length === 0) problems.push(`${view.label}: ${id} has no ALLOW decision with the rules evaluated`);
    const timerKey = typeof message.deferredTimerKey === "string" ? message.deferredTimerKey : undefined;
    if (timerKey !== undefined) {
      const timer = view.find("Timer", (item) => `TIMER#${str(item.kind)}#${str(item.timerId)}` === timerKey && item.operationId === message.operationId);
      if (timer?.status !== "FIRED" || Date.parse(str(timer.dueAtSim)) !== Date.parse(str(message.sentAtSim))) problems.push(`${view.label}: ${id} was deferred but ${timerKey} did not fire at its sending time`);
      const deferral = view.find("Decision", (item) => item.decision === "DEFER" && (item.refs as Record<string, unknown> | undefined)?.timerKey === timerKey);
      if (deferral === undefined) problems.push(`${view.label}: ${id} was deferred without a DEFER decision`);
      else problems.push(...deferralProblems(view, message, str(deferral.atSim), holidays));
    }
  }
  for (const verdict of decideHistory(view, holidays)) {
    if (!verdict.decision.allowed) problems.push(`${view.label}: ${verdict.messageId} (${verdict.operationId}) would be ${verdict.decision.outcome} by ${verdict.decision.ruleIds.join(", ")} at its instant`);
    if (verdict.undecided.length > 0) problems.push(`${view.label}: ${verdict.messageId} could not be decided on ${verdict.undecided.join(", ")} (a fact is missing)`);
  }
  return problems;
}

const FINAL_STATUSES = new Set(["READY_FOR_REVIEW", "APPROVED"]);

/** Invariant 21 over the `guest` and `demo-firm-delta` templates. */
export function tourWindowProblems(view: WorldView, windowEndSim: string = TOUR_WINDOW_END_SIM): string[] {
  const problems: string[] = [];
  const statusOf = new Map(view.of("Operation").map((operation) => [str(operation.operationId), str(operation.dossierStatus)]));
  const start = Date.parse(START_AT_SIM);
  const end = Date.parse(windowEndSim);
  for (const timer of view.of("Timer").filter((item) => item.status === "SCHEDULED")) {
    const operationId = str(timer.operationId);
    const due = Date.parse(str(timer.dueAtSim));
    if (timer.kind === "MILESTONE" && FINAL_STATUSES.has(statusOf.get(operationId) ?? "")) problems.push(`${view.label}: ${operationId} is ${statusOf.get(operationId) ?? "?"} with ${str(timer.timerId)} still scheduled`);
    if (operationId !== TOUR_OPERATION_ID && due >= start && due <= end) problems.push(`${view.label}: ${operationId} has ${str(timer.kind)} ${str(timer.timerId)} at ${str(timer.dueAtSim)}, inside the tour window`);
  }
  return problems;
}
