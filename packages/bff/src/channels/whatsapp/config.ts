// Fixed values of the WhatsApp adapter (ADR-0002, docs/architecture-integrations.md §4): the Meta API
// version the live transport sends with, the markers of the phone simulator's envelope, the SNS topic
// live events arrive from, the SDK budgets and the limits of an inbound message. Nothing here is read
// from the environment; the connected phone number and the WABA are secrets (lib/secrets.ts).
import { MAX_DOCUMENT_BYTES } from "../../domain/documents";
import type { ClientTimeouts } from "../../lib/clients";
import { PDF_CONTENT_TYPE, STAGE_REGION } from "../../public-web/presign";

/** `metaApiVersion` of `SendWhatsAppMessage`; changing it is a reviewed change, never a runtime value. */
export const META_API_VERSION = "v20.0";

/** Meta product of every Cloud API message. */
export const MESSAGING_PRODUCT = "whatsapp";

/** Language of every template (docs/architecture-integrations.md §4.3). */
export const TEMPLATE_LANGUAGE_CODE = "es_AR";

/** `metaPhoneNumberId` and `metadata.phone_number_id` of an envelope built by the phone simulator. */
export const SIMULATED_PHONE_NUMBER_ID = "simulated";

/** Every simulated message id (inbound from the phone, outbound from the simulated transport). */
export const SIM_WAMID_PREFIX = "wamid.SIM.";

/** SNS message attribute that carries the HMAC of the simulated envelope (subkey `sim-envelope`). */
export const SIM_SIGNATURE_ATTRIBUTE = "legajo-sim-signature";

/** `EventSource` of a record the phone simulator hands to `InboundWhatsApp`. */
export const SIM_EVENT_SOURCE = "legajo:phone-simulator";

/** `EventSource` of a record SNS delivers. */
export const SNS_EVENT_SOURCE = "aws:sns";

/** Topic the WABA's event destination publishes to (docs/architecture.md §1); it exists in every mode. */
export const WA_INBOUND_TOPIC_NAME = "aws-cds-hackathon-poc-legajo-wa-inbound";

/** Account of the stage (CLAUDE.md, "Cuenta"): the topic policy's `aws:SourceAccount`. */
export const STAGE_ACCOUNT_ID = "776805327629";

export function waInboundTopicArn(region: string = STAGE_REGION, accountId: string = STAGE_ACCOUNT_ID): string {
  return `arn:aws:sns:${region}:${accountId}:${WA_INBOUND_TOPIC_NAME}`;
}

/** Only PDFs reach the intake, and only up to the intake limit (docs/architecture-integrations.md §4.1). */
export const PDF_MIME_TYPE = PDF_CONTENT_TYPE;
export const MAX_MEDIA_BYTES = MAX_DOCUMENT_BYTES;

/** A simulated outbound message is `sent` at once and `delivered` one second later (§4.2). */
export const SIM_DELIVERED_AFTER_MS = 1_000;

/** `IDEMP#<source>#<wamid>`: an inbound message is processed once. */
export const INBOUND_IDEMPOTENCY_SOURCE = "WHATSAPP";

// End User Messaging Social answers in well under a second; the media download writes to S3 on
// AWS's side and may take longer for a 10 MB PDF.
export const SEND_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };
export const MEDIA_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 20_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };
export const S3_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };
export const INVOKE_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 30_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };

/** Our own retries around a send (the SDK makes one attempt so the total stays bounded). */
export const SEND_RETRY = { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 } as const;
