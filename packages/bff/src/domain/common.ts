// Building blocks every entity schema shares (docs/architecture.md §5): the metadata each DynamoDB
// item carries, the `entity` discriminator, the world stamp of QA and judge worlds, dated histories
// and the small value schemas that repeat across tables. Entities are validated with these schemas
// at the connector edge (reads and writes) and by the seed loader.
import { z } from "zod";
import { JUDGE_TEST_CLOCK_ID, QA_GLOBAL_CLOCK_ID, World, parseClockId } from "@legajo/shared";

/** Every persisted entity, by table (docs/architecture.md §5). */
export const EntityName = z.enum([
  // Firms
  "Firm",
  "FirmSettings",
  "Broker",
  "Checklist",
  "ResponsibilityMatrix",
  // Parties
  "Importer",
  "Consent",
  "SupplierAuthorization",
  "Supplier",
  "SupplierContact",
  "SupplierProfile",
  "AddressClaim",
  // Operations
  "Operation",
  "Document",
  "DocumentVersion",
  "Observation",
  "Escalation",
  "Timer",
  // Conversations
  "Message",
  "MessageEvent",
  "TurnNote",
  "MailboxMessage",
  // AuditLog
  "Decision",
  // Reference
  "Holiday",
  "Template",
  "RateCard",
  "DispatchGlossary",
  "ObservationCode",
  "EvalTruth",
  "NameCheck",
  // Runtime
  "Session",
  "Turn",
  "TurnResult",
  "Nonce",
  "UploadLink",
  "Clock",
  "Idempotency",
  "RateCounter",
  "TurnCap",
  "Counter",
  "OpState",
  "WorldState",
  "MailPending",
  "ScanPending",
  "Lease",
  "Tombstone",
  "Probe",
  "MailProbe",
  // LegajoMetrics
  "DossierKpi",
]);
export type EntityName = z.infer<typeof EntityName>;

// ---- Instants and small values -------------------------------------------------------------------

const ZONED_INSTANT = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/** ISO 8601 instant with its zone (`2026-10-14T10:30:00-03:00`, `2026-10-14T13:30:00.000Z`). */
export const ZonedInstant = z.string().regex(ZONED_INSTANT, "expected an ISO 8601 instant with zone").refine((value) => !Number.isNaN(Date.parse(value)), "invalid instant");
export type ZonedInstant = z.infer<typeof ZonedInstant>;

/**
 * Canonical form of an instant for sort keys and GSI range keys (`dueAtSim`, `etaSort`, `sentAtSim`,
 * `ts`): UTC with milliseconds, so the lexicographic order of DynamoDB is the chronological one
 * whatever zone the caller wrote.
 */
export function utcInstant(instant: string | Date): string {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`invalid instant ${String(instant)}`);
  return new Date(ms).toISOString();
}

/** `expiresAt`: the DynamoDB TTL attribute, in epoch seconds (infra/storage-keys.ts). */
export const EpochSeconds = z.number().int().nonnegative();
export type EpochSeconds = z.infer<typeof EpochSeconds>;

export function epochSecondsAfter(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / 1000) + Math.ceil(seconds);
}

/** An item whose TTL passed is dead even if DynamoDB has not deleted it yet (TTL deletion is lazy). */
export function isExpired(expiresAt: number | undefined, now: Date): boolean {
  return expiresAt !== undefined && expiresAt * 1000 <= now.getTime();
}

export const NonEmptyText = z.string().trim().min(1);
export const HexHash = z.string().regex(/^[0-9a-f]{64}$/, "expected a hex SHA-256 / HMAC");
export const Sha8 = z.string().regex(/^[0-9a-f]{8}$/, "expected 8 hex characters");
export const E164 = z.string().regex(/^\+\d{8,15}$/, "expected an E.164 phone number");
/** Lower-case address as the strict parser of the channels normalizes it. */
export const EmailAddress = z.string().regex(/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, "expected a lower-case email address");
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm");
export const IanaZone = z.string().regex(/^(?:UTC|[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/, "expected an IANA time zone");
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, "expected an ISO 3166-1 alpha-2 code");
export const S3Key = z.string().min(1).max(1024).regex(/^[^\s]+$/, "expected an S3 object key");
export const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");
export const UsdRange = z.object({ min: z.number().nonnegative(), max: z.number().nonnegative() }).refine((range) => range.min <= range.max, "min must not exceed max");

/** Free-form JSON the domain stores opaquely (tool outputs, timer payloads, probe details). */
export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

/** DynamoDB string set, read back as a Set by the DocumentClient; exposed as a sorted array. */
export const StringSet = z
  .union([z.set(z.string()), z.array(z.string())])
  .default([])
  .transform((value) => [...new Set(value)].sort());

// ---- Actors and dated histories -----------------------------------------------------------------

const ACTORS = ["AGENT", "SYSTEM", "IMPORTER", "SUPPLIER", "SEED", "QA"] as const;
const BROKER_ACTOR = /^BROKER:brk-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Who did something: the agent, the deterministic code, a party, the seed, QA or `BROKER:<brokerId>`. */
export const Actor = z.union([z.enum(ACTORS), z.string().regex(BROKER_ACTOR, "expected BROKER:<brokerId>")]);
export type Actor = z.infer<typeof Actor>;

export function brokerActor(brokerId: string): Actor {
  return Actor.parse(`BROKER:${brokerId}`);
}

/**
 * One dated step of a history. Every transition `PolicyAudit` re-evaluates later (consent,
 * authorization, contact status, control, approval) keeps these, so the state at any past simulated
 * instant can be rebuilt (docs/architecture.md §5 and §12).
 */
export const HistoryStamp = z.object({
  atSim: ZonedInstant,
  atReal: ZonedInstant.optional(),
  by: Actor,
  reason: z.string().max(500).optional(),
});
export type HistoryStamp = z.infer<typeof HistoryStamp>;

/** The last entry at or before `atSim` (histories are appended in simulated order). */
export function entryAt<T extends { readonly atSim: string }>(history: readonly T[], atSim: string): T | undefined {
  const at = Date.parse(atSim);
  let found: T | undefined;
  for (const entry of history) if (Date.parse(entry.atSim) <= at) found = entry;
  return found;
}

// ---- Metadata and the world stamp ---------------------------------------------------------------

/** `createdAt`/`updatedAt` (real), `version` (optimistic locking) and the stamps of seeded and world items. */
export const EntityMeta = z.object({
  createdAt: ZonedInstant,
  updatedAt: ZonedInstant,
  version: z.number().int().min(1),
  synthetic: z.boolean().default(false),
  /** `qa` or `judge` on every item of those worlds: the condition of every QA delete (docs/architecture.md §14). */
  world: World.optional(),
  runId: z.string().min(1).max(128).optional(),
  expiresAt: EpochSeconds.optional(),
});
export type EntityMeta = z.output<typeof EntityMeta>;

type StampFields = "synthetic" | "world" | "runId" | "expiresAt";

/**
 * What a caller supplies to create an entity of schema `S`: its input fields (a field with a default
 * may be left out), without the metadata the connector stamps, plus the optional seed and world stamps.
 */
export type NewEntity<S extends z.ZodType> = Omit<z.input<S>, keyof EntityMeta> & Partial<Pick<z.input<typeof EntityMeta>, StampFields>>;

export function defineEntity<T extends z.ZodRawShape>(shape: T) {
  return EntityMeta.extend(shape);
}

/** Items of a QA world expire after 48 hours; the fixed QA and judge-test worlds are restored instead. */
export const QA_WORLD_TTL_SECONDS = 48 * 60 * 60;

/**
 * `world` of an item of this clock (docs/seed-spec.md §14): `qa` for `qa-*` clocks and the two fixed
 * QA clocks, `judge` for any other judge world, nothing for demo and batch worlds.
 */
export function worldOfClock(clockId: string): World | undefined {
  if (clockId === QA_GLOBAL_CLOCK_ID || clockId === JUDGE_TEST_CLOCK_ID) return "qa";
  const scope = parseClockId(clockId)?.scope;
  if (scope === "QA") return "qa";
  if (scope === "JUDGE") return "judge";
  return undefined;
}

/** Only the ephemeral `qa-*` worlds expire by TTL (their ids never repeat). */
export function clockTtlSeconds(clockId: string): number | undefined {
  return parseClockId(clockId)?.scope === "QA" ? QA_WORLD_TTL_SECONDS : undefined;
}
