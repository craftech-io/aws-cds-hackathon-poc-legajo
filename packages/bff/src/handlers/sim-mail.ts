// Stub created by WP-18 (docs/build-plan.md, "Reglas del plan"): Lambda entry of `SimMail`, the
// Lambda action of the receipt rule `sim-poc` of infra/messaging-email.ts, also invoked by
// ScheduleDispatch (`SIM_REPLY`) and the QaDriver (`supplier.sendNow`). WP-30 replaces this file with
// the supplier simulator and demo mailbox of docs/architecture-integrations.md §3. Until then it reads,
// writes and sends nothing and answers UNAVAILABLE; its log line carries no part of the event.
import { createLogger } from "../lib/log";

export async function handler(_event: unknown): Promise<{ readonly status: "UNAVAILABLE" }> {
  createLogger({ bindings: { service: "sim-mail" } }).warn("SimMail entry not built yet (WP-30): simulated mailbox mail ignored");
  return { status: "UNAVAILABLE" };
}
