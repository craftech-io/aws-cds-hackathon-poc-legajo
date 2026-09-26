// Entity ids (docs/seed-spec.md §2). Ids are stable, human-readable and prefixed, so a fixture like
// `obs-4471-PL-GROSS_WEIGHT_MISMATCH` reads on its own in a flow, a log or an audit entry. Each kind
// has a body pattern; `isId`, `idSchema` and `makeId` enforce the same one.
import { z } from "zod";
import { DocType, ObservationCode } from "./enums-dossier";

// Lower-case slug (`firm-judge-01`, `brk-delta-diego`).
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
// QA ids embed the run id, which may be `local-<ULID>` (upper case): `imp-qa-local-01J9ZQ-sc16-b`.
const TOKEN = "[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";
// Operation key: the 4-digit number, plus the clock tag of a cloned world (`4471-j03`).
const OPERATION_KEY = "\\d{4}(?:-[a-z0-9]+)?";
const DOC_SHORT = "(?:CI|PL|CO)";

export const ID_SPEC = {
  firm: { prefix: "firm", body: SLUG },
  broker: { prefix: "brk", body: SLUG },
  importer: { prefix: "imp", body: TOKEN },
  supplier: { prefix: "sup", body: TOKEN },
  contact: { prefix: "ctc", body: TOKEN },
  operation: { prefix: "op", body: OPERATION_KEY },
  docVersion: { prefix: "dv", body: `${OPERATION_KEY}-${DOC_SHORT}-[1-9]\\d*` },
  observation: { prefix: "obs", body: `${OPERATION_KEY}-${DOC_SHORT}-(?:${ObservationCode.options.join("|")})` },
  message: { prefix: "msg", body: "[A-Za-z0-9]+" },
} as const;

export type IdKind = keyof typeof ID_SPEC;
export type IdPrefix = (typeof ID_SPEC)[IdKind]["prefix"];

export const ID_PREFIX = Object.fromEntries(Object.entries(ID_SPEC).map(([kind, spec]) => [kind, spec.prefix])) as {
  readonly [K in IdKind]: (typeof ID_SPEC)[K]["prefix"];
};

const PATTERNS = Object.fromEntries(
  Object.entries(ID_SPEC).map(([kind, spec]) => [kind, new RegExp(`^${spec.prefix}-${spec.body}$`)]),
) as Readonly<Record<IdKind, RegExp>>;

const KIND_BY_PREFIX = new Map<string, IdKind>((Object.keys(ID_SPEC) as IdKind[]).map((kind) => [ID_SPEC[kind].prefix, kind]));

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && PATTERNS[kind].test(value);
}

export function idSchema(kind: IdKind): z.ZodString {
  return z.string().regex(PATTERNS[kind], `expected a ${kind} id "${ID_SPEC[kind].prefix}-…" (docs/seed-spec.md §2)`);
}

/** Joins `parts` with dashes after the prefix; throws RangeError when the result is not a valid id. */
export function makeId(kind: IdKind, ...parts: ReadonlyArray<string | number>): string {
  const id = `${ID_SPEC[kind].prefix}-${parts.map(String).join("-")}`;
  if (!isId(kind, id)) throw new RangeError(`invalid ${kind} id "${id}"`);
  return id;
}

export function kindOfId(value: string): IdKind | undefined {
  const dash = value.indexOf("-");
  if (dash <= 0) return undefined;
  const kind = KIND_BY_PREFIX.get(value.slice(0, dash));
  return kind !== undefined && isId(kind, value) ? kind : undefined;
}

export const FirmId = idSchema("firm");
export type FirmId = z.infer<typeof FirmId>;
export const BrokerId = idSchema("broker");
export type BrokerId = z.infer<typeof BrokerId>;
export const ImporterId = idSchema("importer");
export type ImporterId = z.infer<typeof ImporterId>;
export const SupplierId = idSchema("supplier");
export type SupplierId = z.infer<typeof SupplierId>;
export const ContactId = idSchema("contact");
export type ContactId = z.infer<typeof ContactId>;
export const OperationId = idSchema("operation");
export type OperationId = z.infer<typeof OperationId>;
export const DocVersionId = idSchema("docVersion");
export type DocVersionId = z.infer<typeof DocVersionId>;
export const ObservationId = idSchema("observation");
export type ObservationId = z.infer<typeof ObservationId>;
export const MessageId = idSchema("message");
export type MessageId = z.infer<typeof MessageId>;

/** Short code of a document type in ids, synthetic document ids and file names. */
export const DOC_TYPE_SHORT = {
  COMMERCIAL_INVOICE: "CI",
  PACKING_LIST: "PL",
  CERTIFICATE_OF_ORIGIN: "CO",
} as const satisfies Record<DocType, string>;
export type DocTypeShort = (typeof DOC_TYPE_SHORT)[DocType];

export function docTypeFromShort(short: string): DocType | undefined {
  return DocType.options.find((docType) => DOC_TYPE_SHORT[docType] === short);
}

/** Public operation number: 4 digits (`4471`). */
export const OperationNumber = z.string().regex(/^\d{4}$/, "expected a 4-digit operation number");
export type OperationNumber = z.infer<typeof OperationNumber>;

/**
 * Number ranges (docs/architecture.md §5): `firm-delta` and every judge firm use 4400-4499,
 * `firm-norte` 5500-5599, and QA worlds lease 7000-7999 (`Runtime/LEASE#OPNUM#<n>`).
 */
export const OPERATION_NUMBER_RANGES = {
  delta: { min: 4400, max: 4499 },
  norte: { min: 5500, max: 5599 },
  qa: { min: 7000, max: 7999 },
} as const;
export type OperationNumberRange = keyof typeof OPERATION_NUMBER_RANGES;

export function operationNumberRange(operationNumber: string): OperationNumberRange | undefined {
  const value = Number(OperationNumber.parse(operationNumber));
  return (Object.keys(OPERATION_NUMBER_RANGES) as OperationNumberRange[]).find(
    (range) => value >= OPERATION_NUMBER_RANGES[range].min && value <= OPERATION_NUMBER_RANGES[range].max,
  );
}

/** `op-4471`, or `op-4471-j03` for the clone of a model operation in another world. */
export function operationId(operationNumber: string, clockTag?: string): OperationId {
  const number = OperationNumber.parse(operationNumber);
  return clockTag === undefined ? makeId("operation", number) : makeId("operation", number, clockTag);
}

/** The operation id without its prefix, as other ids embed it (`op-4471-j03` → `4471-j03`). */
export function operationKey(id: string): string {
  return OperationId.parse(id).slice(`${ID_SPEC.operation.prefix}-`.length);
}

export function operationNumberOf(id: string): OperationNumber {
  return operationKey(id).slice(0, 4);
}

/** `dv-4471-PL-1`: version `versionNo` of a document of the operation. */
export function docVersionId(operation: string, docType: DocType, versionNo: number): DocVersionId {
  return makeId("docVersion", operationKey(operation), DOC_TYPE_SHORT[docType], versionNo);
}

/** `obs-4471-PL-GROSS_WEIGHT_MISMATCH`: one observation per operation, document and code; attempts count on it. */
export function observationId(operation: string, docType: DocType, code: ObservationCode): ObservationId {
  return makeId("observation", operationKey(operation), DOC_TYPE_SHORT[docType], code);
}

/**
 * Id printed in every synthetic PDF and stored as its `LegajoDocId` info key (`LDOC-4471-PL-v1`);
 * the reader mock looks it up when the SHA-256 is not in its catalog (docs/seed-spec.md §8).
 */
export const SyntheticDocId = z.string().regex(/^LDOC-\d{4}-(?:CI|PL|CO)-v[1-9]\d*$/, "expected LDOC-<number>-<CI|PL|CO>-v<n>");
export type SyntheticDocId = z.infer<typeof SyntheticDocId>;

export function syntheticDocId(operationNumber: string, docType: DocType, versionNo: number): SyntheticDocId {
  return SyntheticDocId.parse(`LDOC-${OperationNumber.parse(operationNumber)}-${DOC_TYPE_SHORT[docType]}-v${versionNo}`);
}

export function parseSyntheticDocId(value: string): { operationNumber: OperationNumber; docType: DocType; versionNo: number } | undefined {
  if (!SyntheticDocId.safeParse(value).success) return undefined;
  const [, operationNumber = "", short = "", version = ""] = value.split("-");
  const docType = docTypeFromShort(short);
  return docType === undefined ? undefined : { operationNumber, docType, versionNo: Number(version.slice(1)) };
}

/** Zero-padded version number of sort keys and object keys (`DOC#<docType>#V#001`, `v001-<sha8>.pdf`). */
export function padVersion(version: number, width = 3): string {
  if (!Number.isInteger(version) || version < 0) throw new RangeError(`invalid version ${version}`);
  return version.toString().padStart(width, "0");
}

/** `v001` for versioned items (`CHECKLIST#<docType>#v001`, `RESP_MATRIX#v001`): the descending query returns the latest first. */
export function versionTag(version: number, width = 3): string {
  return `v${padVersion(version, width)}`;
}
