// Fixed values of the email channel (docs/architecture.md §1-§2 and §6, docs/architecture-integrations.md
// §1-§3): the links that name the configuration sets and the buckets, attachment limits, the SDK budget
// of the single SES client and the names of the channel's metrics and discard reasons.
import type { SenderProfile } from "@legajo/shared";
import { MAX_DOCUMENT_BYTES } from "../../domain/documents";
import type { ClientTimeouts } from "../../lib/clients";
import { PDF_CONTENT_TYPE, STAGE_REGION } from "../../public-web/presign";

/** SES sends and receives in the stage's region (docs/architecture.md §1). */
export const SES_REGION = STAGE_REGION;
export { PDF_CONTENT_TYPE };

/**
 * Linkables of infra/messaging-email.ts: one sender per profile (linking it grants `ses:SendEmail`
 * fenced to that profile; `configurationSet` names its set), the read of the `ops` route of the mail
 * bucket and the write of the quarantine prefix of `Documents`.
 */
export const EMAIL_SENDER_LINKS: Readonly<Record<SenderProfile, string>> = {
  SYSTEM: "EmailSenderSystem",
  SIMULATOR: "EmailSenderSimulator",
  QA: "EmailSenderQa",
};
export const INBOUND_MAIL_OPS_LINK = "InboundMailOps";
export const QUARANTINE_LINK = "DocumentsQuarantine";

/** Attachments of one inbound email that go to intake; the rest are recorded as rejected. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_BYTES = MAX_DOCUMENT_BYTES;

/** Raw MIME larger than this is not parsed (SES stores up to 40 MB; five 10 MB PDFs in base64 fit). */
export const MAX_RAW_MAIL_BYTES = 40 * 1024 * 1024;

// One `SendEmail` answers in well under a second; throttling is retried by the SDK's own budget.
export const SES_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };
// Reading a raw mail of up to 40 MB, or writing one quarantined PDF.
export const MAIL_STORE_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 15_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

/** Idempotency source of inbound mail (`Runtime/IDEMP#EMAIL#…`). */
export const EMAIL_IDEMPOTENCY_SOURCE = "EMAIL";

/** Metrics the email channel counts with one log line each (docs/architecture.md §12). */
export const EMAIL_METRICS = {
  threadAddressInvalid: "ThreadAddressInvalid",
  outboundSent: "OutboundSent",
} as const;

/** Why an inbound mail stopped before becoming a turn (`PROBE#MAIL#.reason`, `mail.outcome`). */
export const INBOUND_REASONS = {
  threadAddressInvalid: "THREAD_ADDRESS_INVALID",
  threadAddressUnknown: "THREAD_ADDRESS_UNKNOWN",
  tombstoned: "TOMBSTONED",
  untrustedSender: "UNTRUSTED_SENDER",
  ambiguousFrom: "AMBIGUOUS_FROM",
  autoReply: "AUTO_REPLY_IGNORED",
  spamVerdict: "SPAM_VERDICT",
  virusVerdict: "VIRUS_VERDICT",
  sendFailed: "SEND_FAILED",
} as const;
