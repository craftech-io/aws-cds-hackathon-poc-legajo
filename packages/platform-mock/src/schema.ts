// Rows of the mock's own table `Platform` (docs/architecture.md §5): the operation master data
// (`POP#<firmId>#<operationNumber>` / `META`) that `GET /v1/operations/{n}` serves. The world factory
// (packages/bff/src/worlds/, capability WORLDS) and the seed write these rows directly with
// `toPlatformOperationItem`, so the mock and its writers share one schema
// (docs/architecture-integrations.md §6). The log of published events lives in store.ts.
import { z } from "zod";
import {
  ClockId,
  CustomsChannel,
  DispatchStatus,
  DocStatus,
  DocType,
  FirmId,
  ImporterId,
  IsoInstant,
  OperationNumber,
  SupplierId,
  World,
} from "@legajo/shared";

// ---- Primitives of the platform API --------------------------------------------------------------

const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 instant with its zone (`2026-10-22T08:00:00-03:00`): how the platform writes ETAs and event times. */
export const ZonedInstant = IsoInstant.refine((value) => ZONED_INSTANT.test(value), "expected an ISO 8601 instant with its zone");
export type ZonedInstant = z.infer<typeof ZonedInstant>;

/** Milliseconds since the epoch of a zoned instant; two ETAs compare by instant, not by text. */
export function instantMs(value: ZonedInstant): number {
  return Date.parse(ZonedInstant.parse(value));
}

/** Incoterms 2020 rules (the dossier compares the invoice's incoterm against the operation's). */
export const Incoterm = z.enum(["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"]);
export type Incoterm = z.infer<typeof Incoterm>;

const Text = z.string().trim().min(1).max(200);

const ALL_MISSING = { COMMERCIAL_INVOICE: "MISSING", PACKING_LIST: "MISSING", CERTIFICATE_OF_ORIGIN: "MISSING" } as const satisfies Record<DocType, DocStatus>;

/** State of the three documents as the platform has them; `create_operation` copies it (FL-005). */
export const PlatformDocuments = z.record(DocType, DocStatus);
export type PlatformDocuments = z.infer<typeof PlatformDocuments>;

/** Last customs status the platform published; `channel` is set from `CANAL_ASIGNADO` on. */
export const CustomsState = z
  .object({
    status: DispatchStatus,
    channel: CustomsChannel.optional(),
  })
  .strict()
  .refine((state) => state.channel === undefined || state.status === "CANAL_ASIGNADO" || state.status === "LIBERADO", {
    message: "a customs channel exists only once it was assigned",
    path: ["channel"],
  });
export type CustomsState = z.infer<typeof CustomsState>;

// ---- Operation master data -----------------------------------------------------------------------

/**
 * Master data of an operation (CONTEXT.md, "Operación"): importer and supplier by reference, vessel,
 * carrier, regime, port of destination, ETA, invoice and incoterm, plus the documents and the customs
 * status the platform knows. This is also the body of `GET /v1/operations/{n}?firm=<firmId>`.
 */
export const PlatformOperation = z
  .object({
    firmId: FirmId,
    operationNumber: OperationNumber,
    importerId: ImporterId,
    supplierId: SupplierId,
    vessel: Text,
    carrier: Text,
    regime: Text,
    port: Text,
    eta: ZonedInstant,
    invoiceNumber: Text,
    incoterm: Incoterm,
    incotermPlace: Text,
    documents: PlatformDocuments.default(ALL_MISSING),
    customs: CustomsState.default({ status: "NONE" }),
  })
  .strict();
export type PlatformOperation = z.infer<typeof PlatformOperation>;
export type PlatformOperationInput = z.input<typeof PlatformOperation>;

// ---- Table keys and item metadata ----------------------------------------------------------------

export const PLATFORM_META_SK = "META";
export const PLATFORM_EVENT_SK_PREFIX = "EVT#";

/** `POP#firm-delta#4471`: one partition per firm and operation number (numbers repeat across guest firms). */
export function platformPk(firmId: string, operationNumber: string): string {
  return `POP#${FirmId.parse(firmId)}#${OperationNumber.parse(operationNumber)}`;
}

/** `EVT#<createdAt>#<eventId>`: the event log of an operation sorts by the real time it was published. */
export function platformEventSk(createdAt: string, eventId: string): string {
  return `${PLATFORM_EVENT_SK_PREFIX}${IsoInstant.parse(createdAt)}#${eventId}`;
}

/**
 * Attributes every item carries (docs/architecture.md §5): audit times, optimistic `version`, and the
 * world attributes when the row belongs to a QA or guest world (`expiresAt` in epoch seconds).
 */
export const PlatformItemMeta = z
  .object({
    createdAt: IsoInstant,
    updatedAt: IsoInstant,
    version: z.number().int().min(1),
    clockId: ClockId.optional(),
    world: World.optional(),
    runId: z.string().min(1).max(128).optional(),
    expiresAt: z.number().int().positive().optional(),
    synthetic: z.literal(true).optional(),
  })
  .strict();
export type PlatformItemMeta = z.infer<typeof PlatformItemMeta>;

/** World attributes an event row inherits from its operation, so the world's reset and TTL reach it. */
export type PlatformWorldAttributes = Pick<PlatformItemMeta, "clockId" | "world" | "runId" | "expiresAt">;

export const PlatformOperationItem = PlatformOperation.extend({
  PK: z.string().startsWith("POP#"),
  SK: z.literal(PLATFORM_META_SK),
  entity: z.literal("PlatformOperation"),
  ...PlatformItemMeta.shape,
})
  .strict()
  .refine((item) => item.PK === platformPk(item.firmId, item.operationNumber), { message: "PK does not match firmId and operationNumber", path: ["PK"] });
export type PlatformOperationItem = z.infer<typeof PlatformOperationItem>;

export interface PlatformItemOptions extends PlatformWorldAttributes {
  /** Real time of the write (the seed passes its own clock). */
  readonly now: Date;
  readonly synthetic?: true;
}

/** The `META` row of an operation, version 1, as the seed and the world factory write it. */
export function toPlatformOperationItem(data: PlatformOperationInput, options: PlatformItemOptions): PlatformOperationItem {
  const operation = PlatformOperation.parse(data);
  const at = options.now.toISOString();
  return PlatformOperationItem.parse({
    PK: platformPk(operation.firmId, operation.operationNumber),
    SK: PLATFORM_META_SK,
    entity: "PlatformOperation",
    ...operation,
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...worldAttributesOf(options),
    ...(options.synthetic ? { synthetic: true } : {}),
  });
}

/** Only the world attributes that are set: DynamoDB items never carry `undefined`. */
export function worldAttributesOf(source: PlatformWorldAttributes): PlatformWorldAttributes {
  const out: { -readonly [K in keyof PlatformWorldAttributes]: PlatformWorldAttributes[K] } = {};
  if (source.clockId !== undefined) out.clockId = source.clockId;
  if (source.world !== undefined) out.world = source.world;
  if (source.runId !== undefined) out.runId = source.runId;
  if (source.expiresAt !== undefined) out.expiresAt = source.expiresAt;
  return out;
}

const OPERATION_KEYS = PlatformOperation.keyof().options;

/** The API view of a row: the master data without the table attributes. */
export function toPlatformOperation(item: PlatformOperationItem): PlatformOperation {
  return PlatformOperation.parse(Object.fromEntries(OPERATION_KEYS.map((key) => [key, item[key]])));
}
