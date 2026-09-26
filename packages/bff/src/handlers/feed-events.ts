// Stub created by WP-21 (docs/build-plan.md, "Reglas del plan"): Lambda entry of `FeedEvents`, the
// target of the `Feeds` bus rule of infra/feeds.ts (CarrierEtaChanged and CustomsStatusChanged of the
// platform mock). WP-29 replaces this file with the entry that validates the event, resolves the
// operation by firm and number and enqueues ETA_CHANGED or DISPATCH_STATUS
// (docs/architecture-integrations.md §6). Until then it answers UNAVAILABLE and logs no detail.
import { createLogger } from "../lib/log";

export async function handler(_event: unknown): Promise<{ readonly status: "UNAVAILABLE" }> {
  createLogger({ bindings: { service: "feed-events" } }).warn("FeedEvents entry not built yet (WP-29): feed event ignored");
  return { status: "UNAVAILABLE" };
}
