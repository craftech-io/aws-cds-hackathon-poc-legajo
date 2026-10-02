// Lambda entry of `LeadNotice` (ADR-0015 §6; infra/leads.ts): invoked asynchronously by `Bff`
// (`finalizeSignup`) and `WorldJanitor` (`GUEST_SWEEP` retries), `{leadKey}`. Its role reads the lead,
// writes `noticeStatus` and sends through SES with the `LEAD_NOTICE` profile; it has neither `Runtime`
// nor `Conversations` nor `AuditLog`, so the single SES client is built here with ports that refuse to
// be used: the clock-less path of the profile never reaches them (channels/email/outbound.ts).
import { z } from "zod";
import { EMAIL_SENDER_LINKS } from "../channels/email/config";
import { type EmailClient, createEmailClient } from "../channels/email/outbound";
import { tableClient } from "../connector/index";
import { createLogger, newCorrelationId, type Logger } from "../lib/log";
import { currentStage, readLinked } from "../lib/resource";
import { createLeadStore } from "../leads/store";
import { type NoticeOutcome, notifyLead } from "../leads/notice/notice";
import { linkedSecret } from "../signup/deps";

const SenderLink = z.object({ configurationSet: z.string().min(1) });

function unavailable(port: string): () => never {
  return () => {
    throw new Error(`${port} is not available to LeadNotice`);
  };
}

/** The SES client of the lead notice: only the LEAD_NOTICE profile can work with these ports. */
export function leadNoticeEmailClient(log: Logger): EmailClient {
  return createEmailClient({
    fence: { resolveThread: unavailable("resolveThread"), parties: { listContacts: unavailable("Parties"), findContactsByEmailHash: unavailable("Parties") }, emailHash: unavailable("emailHash"), demoRecipients: () => [] },
    world: { putMailPending: unavailable("Runtime"), getMailPending: unavailable("Runtime"), closeMailPending: unavailable("Runtime") },
    runtime: { putMailProbe: unavailable("Runtime") },
    audit: { record: unavailable("AuditLog") },
    configurationSet: (profile) => readLinked(EMAIL_SENDER_LINKS[profile], SenderLink).configurationSet,
    stage: currentStage(),
    now: () => new Date(),
    newMailId: unavailable("mail ids"),
    log,
  });
}

export const handler = async (raw: unknown): Promise<NoticeOutcome> => {
  const log = createLogger({ correlationId: newCorrelationId(), bindings: { service: "lead-notice" } });
  return notifyLead({ leads: createLeadStore(tableClient()), email: leadNoticeEmailClient(log), recipients: () => linkedSecret("LeadNoticeTo"), now: () => new Date(), log }, raw);
};
