// Fixed values of `SimMail` (docs/architecture-integrations.md §3, docs/architecture.md §6, §8, §12 and
// §14): the link of the `sim` route of the mail bucket, the delays of each simulated behaviour, the
// loop guard, the metric a discard counts and the reasons a probe or an audit row carries.
import type { ClientTimeouts } from "../lib/clients";

/** `Resource.InboundMailSim`: bucket and prefix (`poc/sim/`) of the raw MIME the `sim-poc` rule stores. */
export const INBOUND_MAIL_SIM_LINK = "InboundMailSim";

/** Idempotency sources in `Runtime/IDEMP#<source>#…`: a received mail, and the one reply each timer sends. */
export const SIM_MAIL_IDEMPOTENCY_SOURCE = "SIMMAIL";
export const SIM_REPLY_IDEMPOTENCY_SOURCE = "SIM_REPLY";

/** `EmailTags.kind` of everything the simulator sends. */
export const SIM_REPLY_TAG = "SIM_REPLY";

/** Metric of every discarded mail that is not ours (alarm source, docs/architecture.md §12). */
export const SIM_UNTRUSTED_METRIC = "SimUntrusted";

/** Delays of the behaviours, in simulated time (docs/architecture-integrations.md §3). */
export const SIM_DELAYS = {
  /** `PROMPT`, `SEEDED_ERROR`, `SEEDED_ERROR_TWICE`, `WRONG_DOC`, `UNKNOWN_DOC`, `INJECTION`. */
  replyMinutes: 10,
  /** `LATE` without `behaviourParams.delayHours`. */
  lateHours: 24,
  /** `PROMISE`: the documents follow this many hours after the promise. */
  promiseHours: 24,
  /** `AUTO_REPLY`: the real reply follows this many hours after the out-of-office. */
  autoReplyHours: 2,
} as const;

/** The simulator answers an operation at most this many times per simulated day and per real day. */
export const SIM_REPLY_DAILY_CAP = 6;

/** Argentina keeps UTC−3 all year: the simulated day of the loop guard is the broker's calendar day. */
export const SIM_DAY_OFFSET_MS = -3 * 60 * 60 * 1000;

/** The unknown PDFs of the seed (`Seed/pdfs/unknown/<n>.pdf`, docs/seed-spec.md §8). */
export const UNKNOWN_PDF_COUNT = 3;

/** Reading one template PDF or listing a model operation's versions from `Seed`. */
export const SEED_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 10_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

/** Why a mail to a simulated mailbox was discarded as not ours (`PROBE#MAIL#.reason` is always `SIM_UNTRUSTED`). */
export const UNTRUSTED_CAUSES = [
  /** Not exactly one recipient, or one outside `sim.legajo.demo.craftech.io`. */
  "RECIPIENT",
  /** `dmarcVerdict` other than `PASS`. */
  "DMARC",
  /** No single author, or one that is neither an operation's thread address nor `avisos@`. */
  "FROM",
  /** The `Message-ID` is not the `providerMessageId` of an outbound email to exactly this mailbox from this author. */
  "MESSAGE_ID",
  /** The raw MIME names another author or another `Message-ID` than the receipt. */
  "MIME_MISMATCH",
  /** A verified mail whose recipient is neither a firm's nor a supplier's mailbox, or whose outbound says otherwise. */
  "MAILBOX_KIND",
] as const;
export type UntrustedCause = (typeof UNTRUSTED_CAUSES)[number];

/** Why the supplier simulator does not answer a mail that is ours (`PROBE#MAIL#` `NO_REPLY`). */
export const NO_REPLY_REASONS = {
  never: "NEVER",
  sesSimulator: "SES_SIMULATOR",
  autoSubmitted: "AUTO_SUBMITTED",
  notThread: "NOT_A_THREAD",
  worldGone: "WORLD_GONE",
  nothingRequested: "NOTHING_REQUESTED",
  dailyCap: "REPLY_CAP",
} as const;
export type NoReplyReason = (typeof NO_REPLY_REASONS)[keyof typeof NO_REPLY_REASONS];

/** `ACTION` rows the simulator writes to `AuditLog`. */
export const SIM_AUDIT_ACTIONS = {
  untrusted: "SIM_UNTRUSTED",
  reply: "SIM_REPLY",
  replySkipped: "SIM_REPLY_SKIPPED",
  replyFailed: "SIM_REPLY_FAILED",
} as const;
