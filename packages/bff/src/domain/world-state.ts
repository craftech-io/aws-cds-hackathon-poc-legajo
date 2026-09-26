// World-level state in `Runtime` (ADR-0007, docs/architecture.md §7-§8): the demo clock of each
// world with its epoch, the in-flight sets of operations and worlds (quiescence), the pending mails
// and scans that keep a world busy, number and phone leases, and the tombstones of past epochs.
import { z } from "zod";
import {
  ClockId,
  ClockMode,
  FirmId,
  MailAwaiting,
  OperationEventType,
  OperationId,
  SenderProfile,
  WorldTemplateName,
} from "@legajo/shared";
import { EmailAddress, EpochSeconds, NonEmptyText, S3Key, Sha8, StringSet, ZonedInstant, defineEntity } from "./common";

/** Horizon of real schedules (docs/architecture.md §8); the "Reloj en vivo" window is `lib/clock.ts`. */
export const RUNNING_HORIZON_SECONDS = 60 * 60;

export const ClockSettings = z.object({
  /** Messages per sender and simulated hour (`RATE#`); 20 by default. */
  rateLimitPerHour: z.number().int().positive().default(20),
});
export type ClockSettings = z.output<typeof ClockSettings>;

/** A session that acted on a judge world before the current one took over. */
export const PreviousSession = z.object({
  originJti: z.string().min(1).max(128),
  lastActiveAtReal: ZonedInstant,
});
export type PreviousSession = z.infer<typeof PreviousSession>;

/** Last console session that acted on a judge world (`lastSession`, docs/architecture.md §10). */
export const LastSession = z.object({
  originJti: z.string().min(1).max(128),
  authTime: z.number().int().nonnegative(),
  lastActiveAtReal: ZonedInstant,
  /**
   * The other session it took over from: a repeated sign-in check of the same session (a reload, a
   * retried or doubled request) still gets the notice after its own write.
   */
  previous: PreviousSession.optional(),
});
export type LastSession = z.infer<typeof LastSession>;

/** `CLOCK#<clockId>`: never deleted by a reset (only its epoch and time move). */
export const Clock = defineEntity({
  clockId: ClockId,
  firmId: FirmId,
  mode: ClockMode,
  /** `simNow = realNow + offsetMs` while RUNNING. */
  offsetMs: z.number().int().default(0),
  /** `simNow` while PAUSED (every world starts paused). */
  pausedSimNow: ZonedInstant,
  startAtSim: ZonedInstant,
  worldEpoch: z.number().int().min(1),
  template: WorldTemplateName.optional(),
  settings: ClockSettings.default({ rateLimitPerHour: 20 }),
  /** A RUNNING world goes back to PAUSED on its own at this real instant. */
  runningUntilReal: ZonedInstant.optional(),
  lastSession: LastSession.optional(),
  /** "Reiniciar demo" is limited to once every 10 minutes per clock from the console. */
  lastResetAtReal: ZonedInstant.optional(),
});
export type Clock = z.output<typeof Clock>;

export const ProcessError = z.object({
  eventId: z.string().min(1).max(128),
  type: OperationEventType,
  atReal: ZonedInstant,
});
export type ProcessError = z.infer<typeof ProcessError>;

/** `OPSTATE#<operationId>`: events of the operation in flight, and the last dead-lettered one. */
export const OpState = defineEntity({
  operationId: OperationId,
  clockId: ClockId,
  inFlight: StringSet,
  processError: ProcessError.optional(),
});
export type OpState = z.output<typeof OpState>;

/** `WORLDSTATE#<clockId>`: `<operationId>#<eventId>` of every event in flight in the world. */
export const WorldState = defineEntity({
  clockId: ClockId,
  inFlight: StringSet,
});
export type WorldState = z.output<typeof WorldState>;

/** `PENDING#<clockId>` / `MAIL#<mailId>`: written before `SendEmail`, closed by whoever processes the mail. */
export const MailPending = defineEntity({
  clockId: ClockId,
  mailId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "expected a mail id"),
  operationId: OperationId.optional(),
  from: EmailAddress,
  to: EmailAddress,
  profile: SenderProfile,
  awaiting: MailAwaiting,
  sentAtReal: ZonedInstant,
  /** After this real instant the pending is reported STALE instead of waited for. */
  staleAtReal: ZonedInstant,
  expiresAt: EpochSeconds,
});
export type MailPending = z.output<typeof MailPending>;

export const ScanBucket = z.enum(["Uploads", "Media"]);

/** `PENDING#<clockId>` / `SCAN#<sha8 of the key>`: a PDF waiting for the malware scan. */
export const ScanPending = defineEntity({
  clockId: ClockId,
  scanKey: Sha8,
  bucket: ScanBucket,
  objectKey: S3Key,
  operationId: OperationId.optional(),
  createdAtReal: ZonedInstant,
  staleAtReal: ZonedInstant,
  expiresAt: EpochSeconds,
});
export type ScanPending = z.output<typeof ScanPending>;

export const LeaseKind = z.enum(["PHONE", "OPNUM"]);
export type LeaseKind = z.infer<typeof LeaseKind>;

/** `LEASE#PHONE#<n>` / `LEASE#OPNUM#<n>`: a live lease is skipped, never reused blindly (§5). */
export const Lease = defineEntity({
  kind: LeaseKind,
  value: z.string().regex(/^[0-9+]{1,16}$/, "expected a number or an E.164 phone"),
  holder: NonEmptyText,
  acquiredAtReal: ZonedInstant,
  expiresAt: EpochSeconds,
});
export type Lease = z.output<typeof Lease>;

/** `TOMB#<clockId>#<worldEpoch>`: late mail to an operation of a past epoch is discarded. */
export const Tombstone = defineEntity({
  clockId: ClockId,
  worldEpoch: z.number().int().min(1),
  atReal: ZonedInstant,
  expiresAt: EpochSeconds,
});
export type Tombstone = z.output<typeof Tombstone>;
