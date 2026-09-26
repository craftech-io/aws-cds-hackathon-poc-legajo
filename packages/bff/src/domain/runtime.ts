// `Runtime` table, per-turn and per-request state (docs/architecture.md §5): sessions every tool
// derives identity from, turns and their redacted results (the grounding source of G2), button
// nonces, upload links, idempotency marks, rate and turn-cap counters, named counters and probes.
// Never seeded; every item has its TTL.
import { z } from "zod";
import {
  ClockId,
  DocType,
  FirmId,
  ImporterId,
  MessageId,
  OperationId,
  SupplierId,
  TurnTrigger,
  WaButtonAction,
} from "@legajo/shared";
import { EpochSeconds, HexHash, JsonObject, NonEmptyText, ZonedInstant, defineEntity } from "./common";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** TTLs of docs/architecture.md §5 ("Runtime"), in seconds. */
export const RUNTIME_TTL_SECONDS = {
  session: HOUR,
  turn: HOUR,
  nonce: 7 * DAY,
  link: 72 * HOUR,
  idempotency: 7 * DAY,
  rate: 48 * HOUR,
  turnCap: 48 * HOUR,
  lease: 48 * HOUR,
  tombstone: 48 * HOUR,
  pending: 48 * HOUR,
  probe: 48 * HOUR,
} as const;

/** A pending mail or scan older than this is reported `STALE` instead of waited for (§7). */
export const PENDING_STALE_SECONDS = 10 * 60;

const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "expected a session id");
const TurnId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "expected a turn id");

/** Written by the worker before a turn; every tool derives operation, parties and clock from here. */
export const Session = defineEntity({
  sessionId: SessionId,
  turnId: TurnId,
  operationId: OperationId,
  firmId: FirmId,
  importerId: ImporterId,
  supplierId: SupplierId,
  trigger: TurnTrigger,
  clockId: ClockId,
  eventAtSim: ZonedInstant,
  eventId: z.string().min(1).max(128).optional(),
  worldEpoch: z.number().int().min(1),
  sessionEpoch: z.number().int().nonnegative(),
  expiresAt: EpochSeconds,
});
export type Session = z.output<typeof Session>;

/** `TURN#<turnId>/META`: a tool refuses a token whose turn already closed (`closedAtReal`). */
export const Turn = defineEntity({
  turnId: TurnId,
  sessionId: SessionId.optional(),
  operationId: OperationId,
  clockId: ClockId,
  trigger: TurnTrigger,
  openedAtReal: ZonedInstant,
  closedAtReal: ZonedInstant.optional(),
  /** Tool results written so far; allocates the `seq` of the next one. */
  resultCount: z.number().int().nonnegative().default(0),
  expiresAt: EpochSeconds,
});
export type Turn = z.output<typeof Turn>;

/** Snake-case name of the tool or handler that produced a result. */
export const ToolName = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "expected a snake_case tool name");

/** Redacted output of one tool call (`RESULT#<tool>#<seq>`). */
export const TurnResult = defineEntity({
  turnId: TurnId,
  tool: ToolName,
  seq: z.number().int().min(1),
  output: JsonObject,
  atReal: ZonedInstant,
  expiresAt: EpochSeconds,
});
export type TurnResult = z.output<typeof TurnResult>;

/** Opaque button nonce, bound to the importer's phone hash and the operation (7 days). */
export const Nonce = defineEntity({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "expected a nonce"),
  action: WaButtonAction,
  operationId: OperationId,
  importerId: ImporterId,
  phoneHash: HexHash,
  clockId: ClockId,
  messageId: MessageId.optional(),
  payload: JsonObject.default({}),
  usedAtReal: ZonedInstant.optional(),
  expiresAt: EpochSeconds,
});
export type Nonce = z.output<typeof Nonce>;

/** Pre-signed POSTs per link (docs/architecture.md §11). */
export const MAX_PRESIGNS_PER_LINK = 20;

/** Upload link `/u/<token>`: one importer, one operation, 72 real hours (docs/architecture.md §11). */
export const UploadLink = defineEntity({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "expected a 32-byte base64url token"),
  operationId: OperationId,
  importerId: ImporterId,
  firmId: FirmId,
  clockId: ClockId,
  docTypes: z.array(DocType).min(1),
  createdAtReal: ZonedInstant,
  expiresAtReal: ZonedInstant,
  presignCount: z.number().int().nonnegative().default(0),
  lastActivityAtReal: ZonedInstant.optional(),
  completedAtReal: ZonedInstant.optional(),
  turnId: TurnId.optional(),
  expiresAt: EpochSeconds,
});
export type UploadLink = z.output<typeof UploadLink>;

/** Source of an idempotency mark (`IDEMP#<source>#<id>`): the event type or the provider. */
export const IdempotencySource = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, "expected an UPPER_SNAKE_CASE source");

export const Idempotency = defineEntity({
  source: IdempotencySource,
  id: z.string().min(1).max(512),
  firstSeenAtReal: ZonedInstant,
  result: JsonObject.optional(),
  expiresAt: EpochSeconds,
});
export type Idempotency = z.output<typeof Idempotency>;

/** Messages per sender and simulated hour of a world (`RATE#<clockId>#<hash>#<simHour>`). */
export const SimHour = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/, "expected YYYY-MM-DDTHH (UTC)");

export const RateCounter = defineEntity({
  clockId: ClockId,
  addressHash: HexHash,
  simHour: SimHour,
  count: z.number().int().nonnegative(),
  expiresAt: EpochSeconds,
});
export type RateCounter = z.output<typeof RateCounter>;

/** `H<yyyy-mm-ddThh>` (real hour) or `D<yyyy-mm-dd>` (real day), UTC. */
export const TurnCapWindow = z.string().regex(/^(?:H\d{4}-\d{2}-\d{2}T\d{2}|D\d{4}-\d{2}-\d{2})$/, "expected H<yyyy-mm-ddThh> or D<yyyy-mm-dd>");

export const TurnCap = defineEntity({
  firmId: FirmId,
  window: TurnCapWindow,
  count: z.number().int().nonnegative(),
  expiresAt: EpochSeconds,
});
export type TurnCap = z.output<typeof TurnCap>;

/** Named counter (`COUNTER#<name>`); the world epoch lives in `COUNTER#EPOCH#<clockId>` and never expires outside `qa-*`. */
export const Counter = defineEntity({
  name: NonEmptyText,
  value: z.number().int().nonnegative(),
});
export type Counter = z.output<typeof Counter>;

/** Result of a health probe the worker writes for the smoke (`PROBE#<id>`). */
export const Probe = defineEntity({
  probeId: z.string().min(1).max(128),
  kind: NonEmptyText,
  ok: z.boolean(),
  detail: JsonObject.default({}),
  atReal: ZonedInstant,
  expiresAt: EpochSeconds,
});
export type Probe = z.output<typeof Probe>;

/** How the receiver closed a pending mail (`PROBE#MAIL#<mailId>`, `mail.outcome` of the QaDriver). */
export const MailOutcome = z.enum([
  "ENQUEUED",
  "QUARANTINED",
  "DISCARDED",
  "AUTO_REPLY_IGNORED",
  "SIM_UNTRUSTED",
  "MAILBOX",
  "SIM_REPLY_SCHEDULED",
  "SIM_REPLY_SENT",
  "NO_REPLY",
  "SES_EVENT",
]);
export type MailOutcome = z.infer<typeof MailOutcome>;

export const MailProbe = defineEntity({
  mailId: z.string().min(1).max(64),
  outcome: MailOutcome,
  /** `UNTRUSTED_SENDER`, `THREAD_ADDRESS_INVALID`, `THREAD_ADDRESS_UNKNOWN`, `TOMBSTONED`, … */
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  clockId: ClockId,
  operationId: OperationId.optional(),
  atReal: ZonedInstant,
  expiresAt: EpochSeconds,
});
export type MailProbe = z.output<typeof MailProbe>;
