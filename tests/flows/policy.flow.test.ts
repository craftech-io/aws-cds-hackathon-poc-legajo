// Local flows of the contact policy in time (docs/flows-catalog.md, areas C and F): a send out of the
// supplier's business hours is deferred as a `TIMER#DEFERRED_SEND` and goes out when the clock
// reaches it, and free text after the 24-hour window needs a template. The world's clock is paused;
// only the clock module moves it, so the hours are exact.
import { describe, it } from "vitest";
import { NEEDS } from "./support/pending";

describe("contact policy flows", () => {
  it.todo(
    `[FL-033:pending] a turn writes to Qingdao at 23:00 Qingdao time: send_email → DEFER CP-HOURS-SUPPLIER with nextAllowedAt 09:00 supplier time → TIMER#DEFERRED_SEND# → advanceTo(nextAllowedAt) → deferred_send re-evaluates and sends; message DEFERRED → SENT with sentAtSim in the supplier's business hours — needs ${NEEDS.policy}; ${NEEDS.pipeline}; ${NEEDS.timers}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-055:pending] (a) free text inside the 24-hour window goes out; (b) 25 hours after the importer's last message send_whatsapp(text) answers TEMPLATE_REQUIRED and the plan's second call uses legajo_recordatorio; no free text sent — needs ${NEEDS.policy}; ${NEEDS.pipeline}; ${NEEDS.whatsapp}; ${NEEDS.worker}; ${NEEDS.timers}`,
  );
});
