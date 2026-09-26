// Invariant 14 of docs/seed-spec.md §15: the 200 batch entries are inputs only (no field a run would
// produce) and cover the declared distributions exactly; the QA fixture's KPIs are in range and the
// manifest keeps the same aggregates (checked with invariant 18).
import { OperationId } from "@legajo/shared";
import { BATCH_BEHAVIOURS, BATCH_ETA_CHANGES, BATCH_FIRMS, BATCH_SIZE, ETA_DELTA_DAYS, RESULT_FIELDS, type BatchEntry } from "../generate/metrics";
import type { QaFixtureFile } from "../lib/files";

const RESULTS = new Set<string>(RESULT_FIELDS);

function resultKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => resultKeys(entry, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, member]) => [...(RESULTS.has(key) ? [`${path}.${key}`] : []), ...resultKeys(member, `${path}.${key}`)]);
}

function count(entries: readonly BatchEntry[], predicate: (entry: BatchEntry) => boolean): number {
  return entries.filter(predicate).length;
}

export function batchProblems(raw: readonly unknown[], models: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (raw.length !== BATCH_SIZE) problems.push(`the batch has ${raw.length} entries, not ${BATCH_SIZE}`);
  raw.forEach((entry, index) => {
    for (const key of resultKeys(entry)) problems.push(`batch entry ${index + 1} carries a result field ${key}`);
  });
  const entries = raw as BatchEntry[];
  const ids = new Set(entries.map((entry) => entry.entryId));
  if (ids.size !== entries.length) problems.push("batch entry ids repeat");
  entries.forEach((entry, index) => {
    if (entry.entryId !== `sim-${String(index + 1).padStart(4, "0")}` || entry.clockId !== entry.entryId || entry.firmId !== "firm-sim") problems.push(`batch entry ${index + 1} is not sim-${String(index + 1).padStart(4, "0")} of firm-sim`);
    if (!OperationId.safeParse(entry.operation?.model).success || !models.has(entry.operation.model)) problems.push(`batch entry ${index + 1} clones ${String(entry.operation?.model)}, not a model of the seed`);
    for (const change of entry.etaChanges ?? []) if (change.deltaDays < ETA_DELTA_DAYS.min || change.deltaDays > ETA_DELTA_DAYS.max || change.deltaDays === 0) problems.push(`batch entry ${index + 1} moves the ETA ${change.deltaDays} days`);
  });
  const expected: [string, number, number][] = [
    ["Delta entries", BATCH_FIRMS["firm-delta"], count(entries, (entry) => entry.modelFirmId === "firm-delta")],
    ["Norte entries", BATCH_FIRMS["firm-norte"], count(entries, (entry) => entry.modelFirmId === "firm-norte")],
    ["PROMPT suppliers", BATCH_BEHAVIOURS.PROMPT, count(entries, (entry) => entry.operation?.supplierOverride?.behaviour === "PROMPT")],
    ["entries with a seeded error", BATCH_BEHAVIOURS.SEEDED, count(entries, (entry) => (entry.seededErrors ?? []).length > 0)],
    ["BOUNCE suppliers", BATCH_BEHAVIOURS.BOUNCE, count(entries, (entry) => entry.operation?.supplierOverride?.behaviour === "BOUNCE")],
    ["NEVER suppliers", BATCH_BEHAVIOURS.NEVER, count(entries, (entry) => entry.operation?.supplierOverride?.behaviour === "NEVER")],
    ["ETA changes", BATCH_ETA_CHANGES, count(entries, (entry) => (entry.etaChanges ?? []).length > 0)],
  ];
  for (const [what, want, got] of expected) if (want !== got) problems.push(`the batch has ${got} ${what}, the distribution declares ${want}`);
  return problems;
}

const PERCENT_KEYS = new Set(["completeBeforeArrivalPct", "correctResponsiblePct"]);

/** The fixture's KPIs: percentages between 0 and 100, minutes and counts not negative, no violation. */
export function qaFixtureProblems(fixture: QaFixtureFile | undefined): string[] {
  if (fixture === undefined) return ["scripts/seed/data/metrics/qa-fixture.json is missing"];
  const problems: string[] = [];
  if (Object.keys(fixture.aggregates).length === 0) problems.push("the QA fixture produces no KPI");
  for (const [key, value] of Object.entries(fixture.aggregates)) {
    if (value < 0) problems.push(`QA fixture ${key} is negative`);
    if (PERCENT_KEYS.has(key) && value > 100) problems.push(`QA fixture ${key} is over 100 %`);
  }
  if (fixture.aggregates.policyViolations !== 0) problems.push("the QA fixture has policy violations");
  return problems;
}
