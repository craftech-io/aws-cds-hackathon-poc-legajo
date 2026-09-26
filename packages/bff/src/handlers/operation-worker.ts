// Stub created by WP-24 (docs/build-plan.md, "Reglas del plan"): Lambda entry of `OperationWorker`,
// which infra/operations.ts subscribes to OperationEvents.fifo (batch 1). WP-28 replaces this file with
// the worker of docs/architecture.md §7 (intake, timers, agent turns, console sends, feeds). Until then
// it processes nothing and answers UNAVAILABLE by failing: a queue consumer that returned would delete
// the event, so it goes back to the queue and, after its second receive, to OperationEventsDlq.fifo,
// where the DLQ alarm shows it. Its log line carries no part of the event.
import { createLogger } from "../lib/log";

export async function handler(_event: unknown): Promise<never> {
  createLogger({ bindings: { service: "operation-worker" } }).warn("OperationWorker entry not built yet (WP-28): event left on the queue");
  throw new Error("UNAVAILABLE: OperationWorker entry not built yet (WP-28)");
}
