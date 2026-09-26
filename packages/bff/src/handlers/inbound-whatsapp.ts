// Stub created by WP-21 (docs/build-plan.md, "Reglas del plan"): Lambda entry of `InboundWhatsApp`,
// which infra/messaging-whatsapp.ts subscribes to the End User Messaging Social topic and the phone
// simulator invokes. WP-29 replaces this file with the thin entry over the WhatsApp adapter
// (docs/architecture-integrations.md §4). Until then it reads and writes nothing and answers
// UNAVAILABLE; its log line carries no part of the event.
import { createLogger } from "../lib/log";

export interface InboundWhatsAppStubResult {
  readonly status: "UNAVAILABLE";
}

export async function handler(_event: unknown): Promise<InboundWhatsAppStubResult> {
  createLogger({ bindings: { service: "inbound-whatsapp" } }).warn("InboundWhatsApp entry not built yet (WP-29): event ignored");
  return { status: "UNAVAILABLE" };
}
