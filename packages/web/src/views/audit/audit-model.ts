// Pure rules of the bitácora (FL-086): the words of each stored code, the client-side filters by rule
// and by actor (the operation and the decision are filtered by `audit.list` itself), and the counts
// of DENY and DEFER by rule that stand next to the violations counter here and in the metrics.
import { AuditDecision, isRuleId, operationNumberOf } from "@legajo/shared";
import { ruleLabel } from "../../copy/rules";
import type { RouterOutputs } from "../../lib/trpc-router";
import { ACTION_LABELS, ACTOR_LABELS, type ActorKind, TRIGGER_LABELS } from "./copy";

export type AuditRow = RouterOutputs["audit"]["list"]["decisions"][number];

/** `CONSENT_GRANTED` → "Opt-in registrado"; an unknown code → "some new action" (never the raw code). */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? humanizeCode(action);
}

/** `SOME_NEW_CODE` → "some new code". */
export function humanizeCode(code: string): string {
  return code.toLowerCase().replaceAll("_", " ").trim();
}

export function triggerLabel(trigger: string | undefined): string | undefined {
  if (trigger === undefined) return undefined;
  return trigger in TRIGGER_LABELS ? TRIGGER_LABELS[trigger as keyof typeof TRIGGER_LABELS] : humanizeCode(trigger);
}

export function actorKindOf(actor: string): ActorKind {
  if (actor.startsWith("BROKER:")) return "FIRM";
  return actor in ACTOR_LABELS ? (actor as ActorKind) : "SYSTEM";
}

export function actorLabel(actor: string): string {
  return ACTOR_LABELS[actorKindOf(actor)];
}

/** "4471" for `op-4471`; undefined when the decision is not about one operation. */
export function operationNumberOfDecision(row: Pick<AuditRow, "operationId">): string | undefined {
  if (row.operationId === undefined) return undefined;
  try {
    return operationNumberOf(row.operationId);
  } catch {
    return undefined;
  }
}

export interface ClientFilters {
  readonly ruleId?: string;
  readonly actor?: ActorKind;
}

export function filterDecisions(rows: readonly AuditRow[], filters: ClientFilters): AuditRow[] {
  return rows.filter(
    (row) => (filters.ruleId === undefined || (row.ruleIds as readonly string[]).includes(filters.ruleId)) && (filters.actor === undefined || actorKindOf(row.actor) === filters.actor),
  );
}

/** Rules present in the loaded decisions, known rule ids first, alphabetically. */
export function ruleOptions(rows: readonly AuditRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) for (const id of row.ruleIds) ids.add(id);
  return [...ids].sort((a, b) => Number(isRuleId(b)) - Number(isRuleId(a)) || a.localeCompare(b));
}

/** "Horario del proveedor · CP-HOURS-SUPPLIER" for a rule of the filter; any other id as plain words. */
export function ruleOptionLabel(id: string): string {
  return isRuleId(id) ? `${ruleLabel(id)} · ${id}` : humanizeCode(id);
}

/** Actors present in the loaded decisions, in the order of the labels. */
export function actorOptions(rows: readonly AuditRow[]): ActorKind[] {
  const present = new Set(rows.map((row) => actorKindOf(row.actor)));
  return (Object.keys(ACTOR_LABELS) as ActorKind[]).filter((kind) => present.has(kind));
}

export interface RuleCountRow {
  readonly ruleId: string;
  readonly deny: number;
  readonly defer: number;
}

/** `decisionsByRule` as table rows, the rule that stopped the agent most first. */
export function ruleCountRows(byRule: Readonly<Record<string, { readonly deny: number; readonly defer: number }>>): RuleCountRow[] {
  return Object.entries(byRule)
    .map(([ruleId, counts]) => ({ ruleId, deny: counts.deny, defer: counts.defer }))
    .sort((a, b) => b.deny + b.defer - (a.deny + a.defer) || a.ruleId.localeCompare(b.ruleId));
}

export function totals(rows: readonly RuleCountRow[]): { readonly deny: number; readonly defer: number } {
  return rows.reduce((sum, row) => ({ deny: sum.deny + row.deny, defer: sum.defer + row.defer }), { deny: 0, defer: 0 });
}

/** Decision filter value → `audit.list` input (`ALL` sends none). */
export function decisionInput(value: AuditDecision | "ALL"): { decision?: AuditDecision } {
  return value === "ALL" ? {} : { decision: AuditDecision.parse(value) };
}
