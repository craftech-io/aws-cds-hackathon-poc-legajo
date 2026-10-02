// Lambda entry of `SimMail` (infra/messaging-email.ts; docs/architecture-integrations.md §3): the
// supplier simulator and the demo mailbox. Three callers, told apart at the edge with zod:
//
//   - the Lambda action of the receipt rule `sim-poc` (`Records[0].ses`, invocation `Event`): a mail to a
//     simulated mailbox, guarded before anything else (sim-mail/receive.ts);
//   - the timers module's dispatcher (`ScheduleDispatch` for a schedule, `advance_clock` and "Disparar
//     ahora" for the clock): a due `TIMER#SIM_REPLY#` as a `SimReplyHandoff`;
//   - the `QaDriver`'s `supplier.sendNow` (`{action: "sim_reply", mode: "SEND_NOW", …}`), QA worlds only.
//
// Its log lines carry ids and outcomes, never an address, a subject or a body.
import { createLogger, newCorrelationId } from "../lib/log";
import { SimMailInvocation, type SimReplyResult, isReceiptEvent, isSendNow } from "../sim-mail/contract";
import { type SimMailReceipt, receiveSimMail } from "../sim-mail/receive";
import { stageSimMailDeps } from "../sim-mail/stage";
import { fireSimReply, sendNow } from "../sim-mail/supplier-simulator";

export async function handler(event: unknown): Promise<SimMailReceipt | SimReplyResult> {
  const log = createLogger({ correlationId: newCorrelationId(), bindings: { service: "sim-mail" } });
  const deps = stageSimMailDeps({ log });
  if (isReceiptEvent(event)) return receiveSimMail(event, deps);
  const parsed = SimMailInvocation.safeParse(event);
  if (!parsed.success) {
    log.error("SimMail invoked with an unknown event", { issues: parsed.error.issues.length });
    return { status: "REFUSED", code: "INVALID", reason: "unknown SimMail event" };
  }
  const invocation = parsed.data;
  return isSendNow(invocation) ? sendNow(deps, invocation) : fireSimReply(deps, invocation);
}
