// `LegajoMetrics` (docs/architecture.md §5, docs/design-brief.md §8): one KPI row per dossier and
// world or batch run. Counters are incremented atomically by whoever produces them (turns, sends,
// human actions, heartbeats); every number says where it comes from (`source`, `agentMode`).
import { z } from "zod";
import { AgentMode, ClockId, DossierStatus, FirmId, MetricSource, OperationId } from "@legajo/shared";
import { ZonedInstant, defineEntity } from "./common";

const Count = z.number().int().nonnegative().default(0);

/** Real milliseconds from an incoming event to the first message that went out for it (a day at most). */
export const LatencyMs = z.number().int().nonnegative().max(24 * 3_600_000);

/** Numeric fields of a KPI row that only ever grow (atomic `ADD`). */
export const KPI_COUNTERS = [
  "turns",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "whatsappSent",
  "emailSent",
  "humanActions",
  "interventions",
  "escalations",
  "violations",
  "assignmentsTotal",
  "assignmentsCorrect",
  "consoleSeconds",
] as const;
export type KpiCounter = (typeof KPI_COUNTERS)[number];

export const DossierKpi = defineEntity({
  firmId: FirmId,
  source: MetricSource,
  clockId: ClockId,
  operationId: OperationId,
  runId: z.string().min(1).max(128).optional(),
  agentMode: AgentMode,
  turns: Count,
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  /** In simulated mode WhatsApp is valued as if live, and labelled so. */
  whatsappSent: Count,
  emailSent: Count,
  humanActions: Count,
  /** Human actions × minutes per action of the firm (an assumption). */
  humanMinutes: z.number().nonnegative().default(0),
  interventions: Count,
  escalations: Count,
  violations: Count,
  assignmentsTotal: Count,
  assignmentsCorrect: Count,
  /** Observed console time from 30-second heartbeats (secondary metric). */
  consoleSeconds: Count,
  /** One sample per incoming event that got an answer: real ms to its first outbound message (the worker appends it). */
  firstResponseMs: z.array(LatencyMs).default([]),
  dossierStatus: DossierStatus.optional(),
  openedAtSim: ZonedInstant.optional(),
  completedAtSim: ZonedInstant.optional(),
});
export type DossierKpi = z.output<typeof DossierKpi>;
