// Local flows of an ETA change (docs/flows-catalog.md, area G): the carrier moves the ETA on the
// `Feeds` bus, `reschedule_on_eta_change` moves the five milestones deterministically and the turn only
// tells the parties the new deadline. The platform mock runs in process (support/world.ts) and its
// event reaches `FeedEvents` as EventBridge delivers it.
import { describe, it } from "vitest";
import { NEEDS } from "./support/pending";

describe("ETA change flows", () => {
  it.todo(
    `[FL-061:pending] CarrierEtaChanged 22/10 → 20/10 on op-4471: 5 new dueAtSim, version + 1, META.eta and etaHistory; turn ETA_CHANGED with plan get_dossier → send_whatsapp(ETA_CHANGE, template legajo_nuevo_plazo) and, with a request open to the supplier, send_email(ETA_CHANGE) with the deadline in its zone — needs ${NEEDS.feeds}; ${NEEDS.timers}; ${NEEDS.worker}; ${NEEDS.pipeline}`,
  );
  it.todo(
    `[FL-062:pending] CarrierEtaChanged 22/10 → 26/10: later dueAtSim, notice of the new deadline, followups of the agent untouched, no milestone fired twice — needs ${NEEDS.feeds}; ${NEEDS.timers}; ${NEEDS.worker}; ${NEEDS.pipeline}`,
  );
});
