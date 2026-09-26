// The WhatsApp adapter's entry for `InboundWhatsApp` (docs/architecture-integrations.md §4): one call
// per Lambda event, live (SNS from End User Messaging Social) or simulated (the phone simulator's
// signed envelope, same shape). Every record passes the mode gate of registry.ts first; then the
// `statuses[]` of the entry update our messages and each of its `messages[]` goes through
// inbound-message.ts. `handlers/inbound-whatsapp.ts` only builds the deps and returns the summary
// (the simulator reads it: which operation and message the tap became).
import { countMetric } from "../adapter";
import { applyStatuses, type StatusOutcome } from "./events";
import { type MessageResult, processInboundMessage } from "./inbound-message";
import { WhatsAppSnsEvent } from "./payloads";
import type { WhatsAppInboundDeps } from "./ports";
import { type EnvelopeRejection, checkEnvelope } from "./registry";

export const ENVELOPE_REJECTED_METRIC = "WhatsAppEnvelopeRejected";

export interface RecordResult {
  readonly accepted: boolean;
  readonly simulated: boolean;
  readonly reason?: EnvelopeRejection | "INVALID_EVENT";
  readonly messages: readonly MessageResult[];
  readonly statuses: readonly StatusOutcome[];
}

export interface InboundSummary {
  readonly records: readonly RecordResult[];
}

export async function processWhatsAppEvent(event: unknown, deps: WhatsAppInboundDeps): Promise<InboundSummary> {
  const parsed = WhatsAppSnsEvent.safeParse(event);
  if (!parsed.success) {
    countMetric(deps.log, ENVELOPE_REJECTED_METRIC, { reason: "INVALID_EVENT" });
    return { records: [{ accepted: false, simulated: false, reason: "INVALID_EVENT", messages: [], statuses: [] }] };
  }
  const records: RecordResult[] = [];
  for (const record of parsed.data.Records) {
    const check = checkEnvelope(record, { mode: deps.mode, topicArn: deps.source.topicArn, accountId: deps.source.accountId, simEnvelopeKey: deps.keys.simEnvelope });
    if (!check.accepted) {
      countMetric(deps.log, ENVELOPE_REJECTED_METRIC, { reason: check.reason, simulated: check.simulated, mode: deps.mode });
      records.push({ accepted: false, simulated: check.simulated, reason: check.reason, messages: [], statuses: [] });
      continue;
    }
    const messages: MessageResult[] = [];
    const statuses: StatusOutcome[] = [];
    for (const change of check.parsed.changes) {
      statuses.push(...(await applyStatuses(change.statuses, { conversations: deps.data.conversations, log: deps.log }, check.simulated)));
      for (const message of change.messages) {
        messages.push(await processInboundMessage({ deps, simulated: check.simulated, to: change.metadata.phone_number_id }, message));
      }
    }
    records.push({ accepted: true, simulated: check.simulated, messages, statuses });
  }
  return { records };
}
