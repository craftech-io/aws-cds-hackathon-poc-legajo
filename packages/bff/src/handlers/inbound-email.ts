// Stub created by WP-18 (docs/build-plan.md, "Reglas del plan"): Lambda entry of `InboundEmail`, the
// Lambda action of the receipt rule `ops-poc` of infra/messaging-email.ts (after the S3 action stores
// the raw MIME under `Resource.InboundMailOps.prefix`). WP-29 replaces this file with the thin entry
// that runs the mandatory order of docs/architecture-integrations.md §2 over the email adapter. Until
// then it reads and writes nothing and answers UNAVAILABLE; its log line carries no part of the event.
import { createLogger } from "../lib/log";

export async function handler(_event: unknown): Promise<{ readonly status: "UNAVAILABLE" }> {
  createLogger({ bindings: { service: "inbound-email" } }).warn("InboundEmail entry not built yet (WP-29): received mail left in the bucket");
  return { status: "UNAVAILABLE" };
}
