// Which WhatsApp transport runs and which envelopes `InboundWhatsApp` accepts, both decided by
// `ChannelModes.whatsapp` (ADR-0002, FL-100). `channels/registry.ts` asks `createWhatsAppTransport` for
// the transport of the mode; nothing else knows the mode. Envelopes:
//
//   simulated envelope + mode live       → refused (SIMULATED_IN_LIVE)
//   simulated envelope + mode simulated  → accepted only with a valid `sim-envelope` signature
//   live envelope, either mode           → accepted only from the stage's topic by SNS, for this account
//                                          (the topic exists in every mode; its policy admits only
//                                          `social-messaging.amazonaws.com` of the account)
import type { ChannelMode } from "@legajo/shared";
import type { SecretKey } from "../../lib/crypto";
import { SNS_EVENT_SOURCE } from "./config";
import { type LiveTransportDeps, liveWhatsAppTransport } from "./live-transport";
import { type ParsedEnvelope, PayloadError, type SnsRecord, parseEnvelope } from "./payloads";
import { hasValidSimSignature, looksSimulated } from "./sim-envelope";
import { type SimulatedTransportDeps, type SimulatedWhatsAppTransport, simulatedWhatsAppTransport } from "./simulated-transport";
import type { WhatsAppTransport } from "./transport";

export type EnvelopeRejection = "INVALID_PAYLOAD" | "SIMULATED_IN_LIVE" | "BAD_SIGNATURE" | "NOT_FROM_TOPIC" | "FOREIGN_ACCOUNT";

export type EnvelopeCheck =
  | { readonly accepted: true; readonly simulated: boolean; readonly parsed: ParsedEnvelope }
  | { readonly accepted: false; readonly simulated: boolean; readonly reason: EnvelopeRejection };

export interface EnvelopeExpectations {
  readonly mode: ChannelMode;
  /** `arn:aws:sns:us-east-1:<account>:aws-cds-hackathon-poc-legajo-wa-inbound` (config.ts `waInboundTopicArn`). */
  readonly topicArn: string;
  readonly accountId: string;
  /** Subkey `sim-envelope` (lib/secrets.ts `subkey`). */
  readonly simEnvelopeKey: SecretKey;
}

/** The gate of every record `InboundWhatsApp` receives, before anything is read from it. */
export function checkEnvelope(record: SnsRecord, expect: EnvelopeExpectations): EnvelopeCheck {
  let parsed: ParsedEnvelope | undefined;
  let invalid = false;
  try {
    parsed = parseEnvelope(record.Sns.Message);
  } catch (error) {
    if (!(error instanceof PayloadError)) throw error;
    invalid = true;
  }
  const simulated = looksSimulated(record, parsed);
  if (simulated && expect.mode === "live") return { accepted: false, simulated, reason: "SIMULATED_IN_LIVE" };
  if (simulated && !hasValidSimSignature(expect.simEnvelopeKey, record)) return { accepted: false, simulated, reason: "BAD_SIGNATURE" };
  if (!simulated && (record.EventSource !== SNS_EVENT_SOURCE || record.Sns.TopicArn !== expect.topicArn)) return { accepted: false, simulated, reason: "NOT_FROM_TOPIC" };
  if (invalid || parsed === undefined) return { accepted: false, simulated, reason: "INVALID_PAYLOAD" };
  if (!simulated && parsed.envelope.aws_account_id !== expect.accountId) return { accepted: false, simulated, reason: "FOREIGN_ACCOUNT" };
  return { accepted: true, simulated, parsed };
}

export interface TransportFactoryDeps {
  readonly simulated: SimulatedTransportDeps;
  /** Only needed (and only built) in live mode: the connection exists once P-01 is closed. */
  readonly live?: () => LiveTransportDeps;
}

/** One factory per mode, as channels/registry.ts takes them: it instantiates the one `ChannelModes` names. */
export function whatsAppFactories(deps: TransportFactoryDeps): { readonly simulated: () => SimulatedWhatsAppTransport; readonly live: () => WhatsAppTransport } {
  return {
    simulated: () => simulatedWhatsAppTransport(deps.simulated),
    live: () => {
      if (deps.live === undefined) throw new RangeError("live WhatsApp needs its connection (WabaId and WhatsAppPhoneNumberId)");
      return liveWhatsAppTransport(deps.live());
    },
  };
}

export function createWhatsAppTransport(mode: "simulated", deps: TransportFactoryDeps): SimulatedWhatsAppTransport;
export function createWhatsAppTransport(mode: ChannelMode, deps: TransportFactoryDeps): WhatsAppTransport;
export function createWhatsAppTransport(mode: ChannelMode, deps: TransportFactoryDeps): WhatsAppTransport {
  return whatsAppFactories(deps)[mode]();
}
