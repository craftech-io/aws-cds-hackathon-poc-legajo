// Readers over a `snapshot` (qa-driver/snapshot.ts) for the asserts of docs/test-plan.md §4.3: stored
// state, structured messages (`kind`, `refs`, `ruleIds`), decisions of the audit log and timers.
// Never the model's wording: text is only searched for grounded facts and forbidden patterns.
import type { QaSnapshot } from "@legajo/bff/qa-driver/snapshot";
import type { BlockOrigin } from "./steps";

type Message = QaSnapshot["messages"][number];
type Decision = QaSnapshot["decisions"][number];
type Timer = QaSnapshot["timers"][number];

export interface MessageFilter {
  readonly direction?: Message["direction"];
  readonly channel?: Message["channel"];
  readonly kind?: NonNullable<Message["kind"]> | readonly NonNullable<Message["kind"]>[];
  readonly counterpart?: Message["counterpart"];
  readonly status?: Message["status"] | readonly Message["status"][];
  readonly author?: string;
  /** Only messages sent at or after this simulated instant. */
  readonly sinceSim?: string;
}

const oneOf = <T>(value: T, wanted: T | readonly T[] | undefined): boolean => wanted === undefined || (Array.isArray(wanted) ? wanted.includes(value) : value === wanted);

export function messages(snapshot: QaSnapshot, filter: MessageFilter = {}): Message[] {
  return snapshot.messages.filter(
    (message) =>
      oneOf(message.direction, filter.direction) &&
      oneOf(message.channel, filter.channel) &&
      (filter.kind === undefined || (message.kind !== undefined && oneOf(message.kind, filter.kind))) &&
      oneOf(message.counterpart, filter.counterpart) &&
      oneOf(message.status, filter.status) &&
      (filter.author === undefined || message.author === filter.author) &&
      (filter.sinceSim === undefined || Date.parse(message.sentAtSim) >= Date.parse(filter.sinceSim)),
  );
}

export const outbound = (snapshot: QaSnapshot, filter: Omit<MessageFilter, "direction"> = {}) => messages(snapshot, { ...filter, direction: "OUT" });
export const inbound = (snapshot: QaSnapshot, filter: Omit<MessageFilter, "direction"> = {}) => messages(snapshot, { ...filter, direction: "IN" });

/** Sent means it left: SENT or any later delivery status. */
export const SENT_STATUSES = ["SENT", "DELIVERED", "READ"] as const;

export interface DecisionFilter {
  readonly decision?: Decision["decision"];
  readonly action?: string;
  readonly ruleId?: string;
}

export function decisions(snapshot: QaSnapshot, filter: DecisionFilter = {}): Decision[] {
  return snapshot.decisions.filter(
    (row) => oneOf(row.decision, filter.decision) && (filter.action === undefined || row.action === filter.action) && (filter.ruleId === undefined || row.ruleIds.includes(filter.ruleId as never)),
  );
}

export function document(snapshot: QaSnapshot, docType: QaSnapshot["documents"][number]["docType"]) {
  const found = snapshot.documents.find((row) => row.docType === docType);
  if (found === undefined) throw new Error(`the snapshot has no ${docType}`);
  return found;
}

export const allValid = (snapshot: QaSnapshot): boolean => snapshot.documents.length === 3 && snapshot.documents.every((row) => row.status === "VALID");

export function timers(snapshot: QaSnapshot, filter: { readonly kind?: Timer["kind"]; readonly timerId?: string; readonly status?: Timer["status"] } = {}): Timer[] {
  return snapshot.timers.filter((timer) => oneOf(timer.kind, filter.kind) && oneOf(timer.status, filter.status) && (filter.timerId === undefined || timer.timerId === filter.timerId));
}

export const milestone = (snapshot: QaSnapshot, name: string): Timer | undefined => timers(snapshot, { kind: "MILESTONE", timerId: name })[0];

/** The next pending timer of the operation, earliest first. */
export function nextPending(snapshot: QaSnapshot, kind?: Timer["kind"]): QaSnapshot["pendingTimers"][number] | undefined {
  return [...snapshot.pendingTimers].filter((timer) => kind === undefined || timer.kind === kind).sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim))[0];
}

export const openEscalations = (snapshot: QaSnapshot, reason?: string) => snapshot.escalations.filter((row) => row.status === "OPEN" && (reason === undefined || row.reason === reason));

export const observations = (snapshot: QaSnapshot, filter: { readonly code?: string; readonly docType?: string } = {}) =>
  snapshot.observations.filter((row) => (filter.code === undefined || row.code === filter.code) && (filter.docType === undefined || row.docType === filter.docType));

/** Same instant, whatever zone each side is written in. */
export const sameInstant = (a: string | undefined, b: string): boolean => a !== undefined && Date.parse(a) === Date.parse(b);

type Origin = Exclude<BlockOrigin, "NONE">;

/** Where each block after `sinceSim` came from, read from the decision log (docs/test-plan.md §4.3). */
export function blockOrigins(snapshot: QaSnapshot, sinceSim: string): Array<{ readonly origin: Origin; readonly detail: string }> {
  const out: Array<{ origin: Origin; detail: string }> = [];
  for (const row of snapshot.decisions) {
    if (Date.parse(row.ts) < Date.parse(sinceSim)) continue;
    const rules = row.ruleIds.join(",");
    if (row.action === "GUARDRAIL_BLOCK") out.push({ origin: row.detail?.origin === "PREFILTER" ? "PREFILTER" : "HARNESS_G1", detail: `${row.action} ${String(row.detail?.source ?? "")}`.trim() });
    else if (row.action === "AGENT_REFUSAL") out.push({ origin: "MODEL_REFUSAL", detail: row.action });
    else if (row.decision === "DENY" && /\bCED-/.test(rules)) out.push({ origin: "CEDAR", detail: rules });
    else if (row.decision === "DENY" && /\bLAM-/.test(rules)) out.push({ origin: "LAMBDA_FENCE", detail: rules });
    else if (row.decision === "DENY" && (row.action === "GROUNDING_FAIL" || rules.includes("G2") || rules.includes("CP-NO-FOREIGN-LINKS"))) out.push({ origin: "OUTBOUND_VERIFY", detail: `${row.action} ${rules}` });
  }
  return out;
}
