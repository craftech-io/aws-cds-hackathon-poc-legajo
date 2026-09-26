// The metrics fixture of `GLOBAL#firm-qa` (docs/seed-spec.md §1 and §3): the KPI rows of the three
// closed dossiers of the `qa-min` template (clones of op-4487, op-4488 and op-4489, whose histories
// and decisions the template carries) and the KPIs they must produce, computed with the console's own
// `summarize` (packages/bff/src/metrics/kpis.ts) so `SC-20/4` compares against the same arithmetic.
import { summarize } from "@legajo/bff/metrics/kpis";
import { Decision } from "@legajo/bff/domain/audit";
import { FirmSettings } from "@legajo/bff/domain/firms";
import { DossierKpi } from "@legajo/bff/domain/metrics";
import { Operation } from "@legajo/bff/domain/operations";
import { RateCard } from "@legajo/bff/domain/reference";
import { QA_CLOCK } from "../lib/constants";
import { templateItem, type SeedItem } from "../lib/items";
import { openedAtSim } from "./world-operations";
import type { WorldContext } from "./world-context";

interface FixtureCounters {
  readonly turns: number;
  readonly tokens: readonly [number, number, number, number];
  readonly whatsappSent: number;
  readonly humanActions: number;
  readonly humanMinutes: number;
  readonly interventions: number;
  readonly escalations: number;
  readonly assignments: readonly [number, number];
  readonly consoleSeconds: number;
  readonly firstResponseMs: readonly number[];
  readonly completedAtSim: string;
}

/** Counters of each closed dossier, consistent with its seeded history (messages, approvals, escalations). */
const COUNTERS: Readonly<Record<string, FixtureCounters>> = {
  "4487": { turns: 2, tokens: [21400, 1620, 15800, 5200], whatsappSent: 2, humanActions: 1, humanMinutes: 10, interventions: 1, escalations: 0, assignments: [0, 0], consoleSeconds: 240, firstResponseMs: [], completedAtSim: "2026-10-09T15:45:00-03:00" },
  "4488": { turns: 3, tokens: [33800, 2410, 24900, 6800], whatsappSent: 2, humanActions: 0, humanMinutes: 0, interventions: 0, escalations: 1, assignments: [1, 1], consoleSeconds: 0, firstResponseMs: [48000, 41000], completedAtSim: "2026-10-13T16:32:00-03:00" },
  "4489": { turns: 2, tokens: [20100, 1490, 14700, 4900], whatsappSent: 5, humanActions: 1, humanMinutes: 10, interventions: 1, escalations: 0, assignments: [0, 0], consoleSeconds: 180, firstResponseMs: [], completedAtSim: "2026-10-05T09:45:00-03:00" },
};

/** `LegajoMetrics` rows of the fixture (template form: `WORLD` rows of the QA world). */
export function qaFixtureRows(world: WorldContext): SeedItem[] {
  return world.operations.flatMap((op) => {
    const counters = COUNTERS[op.model.number];
    if (counters === undefined) return [];
    const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = counters.tokens;
    return [
      templateItem("DossierKpi", {
        firmId: world.firm.firmId,
        source: "WORLD",
        clockId: QA_CLOCK,
        operationId: op.operationId,
        agentMode: "REAL",
        turns: counters.turns,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        whatsappSent: counters.whatsappSent,
        emailSent: 0,
        humanActions: counters.humanActions,
        humanMinutes: counters.humanMinutes,
        interventions: counters.interventions,
        escalations: counters.escalations,
        violations: 0,
        assignmentsTotal: counters.assignments[0],
        assignmentsCorrect: counters.assignments[1],
        consoleSeconds: counters.consoleSeconds,
        firstResponseMs: [...counters.firstResponseMs],
        dossierStatus: op.model.dossierStatus,
        openedAtSim: openedAtSim(op.model.eta),
        completedAtSim: counters.completedAtSim,
      }),
    ];
  });
}

export interface QaFixtureInput {
  readonly rows: readonly SeedItem[];
  readonly operations: readonly SeedItem[];
  readonly settings: SeedItem;
  readonly decisions: readonly SeedItem[];
  readonly rateCard: readonly SeedItem[];
}

/** The KPIs of "Este mundo" for `GLOBAL#firm-qa`; only the ones with a number (a gap has none to compare). */
export function qaFixtureAggregates(input: QaFixtureInput): Record<string, number> {
  const rows = input.rows.map((row) => DossierKpi.parse(row));
  const decisions = input.decisions.map((decision) => Decision.parse(decision));
  const etaHistories = new Map(input.operations.filter((item) => item.entity === "Operation").map((item) => {
    const operation = Operation.parse(item);
    return [operation.operationId, operation.etaHistory] as const;
  }));
  const summary = summarize({
    tab: "WORLD",
    rows,
    settings: FirmSettings.parse(input.settings),
    etaHistories,
    violations: decisions.filter((decision) => decision.decision === "VIOLATION"),
    denials: decisions.filter((decision) => decision.decision === "DENY" || decision.decision === "DEFER"),
    rateCard: input.rateCard.map((row) => RateCard.parse(row)),
    whatsappSimulated: true,
  });
  return Object.fromEntries(summary.kpis.flatMap((kpi) => (kpi.value === null ? [] : [[kpi.key, kpi.value] as const])));
}
