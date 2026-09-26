// Stub created by WP-18 (docs/build-plan.md, "Reglas del plan"): Lambda entry of `ChannelEvents`, the
// target of the default-bus rule of infra/messaging-email.ts (SES delivery events of the configuration
// set `…-email-poc`). WP-29 replaces this file with the entry that maps each event to the message
// status, closes the `SES_EVENT` pendings and enqueues EMAIL_EVENT (docs/architecture-integrations.md
// §1). Until then it reads and writes nothing and answers UNAVAILABLE; its log line carries no part of
// the event.
import { createLogger } from "../lib/log";

export async function handler(_event: unknown): Promise<{ readonly status: "UNAVAILABLE" }> {
  createLogger({ bindings: { service: "channel-events" } }).warn("ChannelEvents entry not built yet (WP-29): SES event ignored");
  return { status: "UNAVAILABLE" };
}
