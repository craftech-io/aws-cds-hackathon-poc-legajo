// What a turn leaves behind besides its tools' effects (docs/architecture.md §9.1, docs/design-brief.md §8):
//
//   TurnNote        the final text of the Harness (ADR-0011: an internal note, never sent), or a fixed
//                   code when there was no turn (`TURN_QUOTA`) or its text must not be kept (a guardrail's
//                   sentinel, a failed turn)
//   LegajoMetrics   the turn and its tokens (`metadata.usage`), and the first-response latency: real ms
//                   from the inbound message to the first outbound of the turn that answered it
//   metrics         `TurnLatency` and `TurnErrors` log lines for the metric filters of §12
//
// The KPI row is the world's (`WORLD`), or the batch's (`BATCH`, `runId` = the batch id) in a `sim-*`
// world; `agentMode` says whether the Harness was real or the scripted one of the local flows.
import { type AgentMode, ConnectorError, parseClockId } from "@legajo/shared";
import { countMetric } from "../channels/adapter";
import type { Connector, KpiRef } from "../connector/index";
import { LatencyMs, type DossierKpi } from "../domain/metrics";
import type { Message, TokenUsage } from "../domain/conversations";
import type { Operation } from "../domain/operations";
import { maskText } from "../lib/mask";
import type { Logger } from "../lib/log";
import type { TurnEvent } from "../worker/events";

export const TURN_METRICS = { latency: "TurnLatency", errors: "TurnErrors" } as const;

/** Fixed notes of the turns that left no text of the model. */
export const FIXED_NOTES = {
  quota: "TURN_QUOTA",
  guardrail: "GUARDRAIL_BLOCK",
  failed: "TURN_FAILED",
} as const;

export interface TurnRecordDeps {
  readonly data: Pick<Connector, "conversations" | "metrics">;
  readonly agentMode: AgentMode;
  readonly now: () => Date;
  readonly log: Logger;
}

export function kpiRefOf(operation: Pick<Operation, "firmId" | "clockId" | "operationId">): KpiRef {
  const batch = parseClockId(operation.clockId)?.scope === "SIM";
  return { firmId: operation.firmId, source: batch ? "BATCH" : "WORLD", clockId: operation.clockId, operationId: operation.operationId };
}

function identityOf(deps: TurnRecordDeps, operation: Pick<Operation, "clockId">): Pick<DossierKpi, "agentMode"> & Partial<Pick<DossierKpi, "runId">> {
  const batch = parseClockId(operation.clockId)?.scope === "SIM";
  return { agentMode: deps.agentMode, ...(batch ? { runId: operation.clockId.slice("sim-".length) } : {}) };
}

export interface NoteInput {
  readonly operation: Pick<Operation, "operationId" | "clockId">;
  readonly event: TurnEvent;
  readonly turnId: string;
  readonly text: string;
  readonly usage?: TokenUsage;
  readonly stopReason?: string;
}

/** Appends the note; a retried event that already wrote it leaves the first one. */
export async function writeTurnNote(deps: TurnRecordDeps, input: NoteInput): Promise<void> {
  const text = maskText(input.text).trim() || FIXED_NOTES.failed;
  try {
    await deps.data.conversations.appendTurnNote({
      turnId: input.turnId,
      operationId: input.operation.operationId,
      clockId: input.operation.clockId,
      trigger: input.event.trigger,
      text: [...text].slice(0, 4_000).join(""),
      atSim: input.event.eventAtSim,
      atReal: deps.now().toISOString(),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason.slice(0, 64) }),
    });
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
  }
}

/** One turn and its tokens on the dossier's KPI row. */
export async function recordUsage(deps: TurnRecordDeps, operation: Pick<Operation, "firmId" | "clockId" | "operationId">, usage: TokenUsage): Promise<void> {
  await deps.data.metrics.incrementKpi(
    kpiRefOf(operation),
    { turns: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens },
    identityOf(deps, operation),
  );
}

/**
 * Real ms from the inbound message to the first outbound message of the turn that answered it; nothing
 * when the turn sent nothing (the agent may rightly stay silent) or the sample is out of range.
 */
export async function recordFirstResponse(deps: TurnRecordDeps, operation: Pick<Operation, "firmId" | "clockId" | "operationId">, turnId: string, inbound: Message): Promise<number | undefined> {
  const sent = (await deps.data.conversations.listMessages(operation.operationId, { direction: "OUT" })).filter((message) => message.turnId === turnId);
  if (sent.length === 0) return undefined;
  const first = Math.min(...sent.map((message) => Date.parse(message.sentAtReal)));
  const latency = LatencyMs.safeParse(first - Date.parse(inbound.sentAtReal));
  if (!latency.success) return undefined;
  await deps.data.metrics.recordFirstResponse(kpiRefOf(operation), latency.data, identityOf(deps, operation));
  return latency.data;
}

/** `TurnLatency` (real ms of the Harness call) for the metric filter. */
export function logTurnLatency(log: Logger, latencyMs: number, fields: Readonly<Record<string, unknown>>): void {
  countMetric(log, TURN_METRICS.latency, { ...fields, latencyMs });
}

export function logTurnError(log: Logger, fields: Readonly<Record<string, unknown>>): void {
  countMetric(log, TURN_METRICS.errors, fields);
}
