// Stub created by WP-24 (docs/build-plan.md, "Reglas del plan"): Lambda entry of `DocumentIntake`, the
// target of the rule infra/operations.ts puts on the default bus for GuardDuty's scan results of
// Uploads and Media. WP-29 replaces this file with the intake of docs/architecture-integrations.md §7
// (token, key, `%PDF-`, size, INTAKE_DOCUMENT, closing the ScanPending). Until then it reads, writes and
// enqueues nothing and answers UNAVAILABLE; its log line carries no part of the event.
import { createLogger } from "../lib/log";

export async function handler(_event: unknown): Promise<{ readonly status: "UNAVAILABLE" }> {
  createLogger({ bindings: { service: "document-intake" } }).warn("DocumentIntake entry not built yet (WP-29): scan result ignored");
  return { status: "UNAVAILABLE" };
}
