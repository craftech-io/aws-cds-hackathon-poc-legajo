// The stage's ports of the intake that are the intake's own: where a PDF is read from, `Documents`
// with the reader's pre-signed GET, the one reader client, and timers armed through the timers module
// (a `TIMER#` plus its schedule while the world runs). The worker's entry composes them with what is
// its own (the connector, the escalation with the firm's email, its queue sink, its logger).
import { armTimer, type TimerDeps } from "../timers/timers";
import { linkedReaderClient } from "../reader/linked";
import type { IntakeDeps, TimerScheduler } from "./ports";
import { s3DocumentStore, s3SourceStore } from "./storage";

export function armedTimerScheduler(deps: TimerDeps): TimerScheduler {
  return { schedule: async (spec) => (await armTimer(spec, deps)).timer };
}

/** Sources, `Documents` and the reader of `OperationWorker`, resolved from its links on first use. */
export function stageIntakePorts(): Pick<IntakeDeps, "sources" | "documents" | "reader"> {
  return {
    sources: s3SourceStore(),
    documents: s3DocumentStore(),
    reader: { createReading: (input) => linkedReaderClient().createReading(input) },
  };
}
