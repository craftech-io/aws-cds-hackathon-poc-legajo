// Stub created by WP-24 (docs/build-plan.md, "Reglas del plan"): Lambda entry of `ScheduleDispatch`, the
// target of every timer schedule of the group infra/scheduler.ts creates. WP-29 replaces this file with
// the entry that checks the timer's version and enqueues TIMER on OperationEvents.fifo, or hands
// SIM_REPLY to SimMail (docs/architecture.md §7 and §8). Until then it reads, enqueues and invokes
// nothing and answers UNAVAILABLE; its log line carries no part of the event.
import { createLogger } from "../lib/log";

export async function handler(_event: unknown): Promise<{ readonly status: "UNAVAILABLE" }> {
  createLogger({ bindings: { service: "schedule-dispatch" } }).warn("ScheduleDispatch entry not built yet (WP-29): timer ignored");
  return { status: "UNAVAILABLE" };
}
