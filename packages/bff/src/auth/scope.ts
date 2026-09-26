// The firm fence of the console (docs/architecture.md §10, FL-082): every id a request carries is
// checked against the firm of the principal before the procedure runs. `firmProcedure`
// (routers/trpc.ts) walks the raw input for id-valued fields, resolves which firm owns each id and
// refuses the whole request with 403 + `AuditLog DENY CROSS_FIRM` when one belongs to another firm.
// An id that does not exist is not this fence's business: the procedure answers NOT_FOUND or
// creates it.
//
//   firm          the id itself                     clock      GLOBAL#/JUDGE# name their firm;
//   operation     Operations META `firmId`                     qa-* → firm-qa, sim-* → firm-sim
//   importer      Parties importer `firmId`         docVersion `dv-<op>-…`  → its operation
//   supplier      Parties supplier `firmId`         observation `obs-<op>-…` → its operation
//
// Contacts, messages, escalations and brokers live under one of the above and are always read
// through it, so the procedure's own lookup scopes them.
import { kindOfId, parseClockId, type IdKind } from "@legajo/shared";
import type { Connector } from "../connector/connector";

export type FencedKind = "firm" | "clock" | "operation" | "importer" | "supplier" | "docVersion" | "observation";

export interface FencedId {
  readonly kind: FencedKind;
  readonly id: string;
}

const FENCED_ID_KINDS: ReadonlySet<IdKind> = new Set<IdKind>(["firm", "operation", "importer", "supplier", "docVersion", "observation"]);

// `operationId`, `targetOperationId`, `importerIds`, `clockId`, `id`…
const ID_FIELD = /(?:^ids?$|Ids?$)/;

// The walk is bounded: console inputs are small, and a hostile one must not buy unbounded lookups.
const MAX_DEPTH = 6;
const MAX_IDS = 50;

/** Classifies one value; `undefined` when it is not an id this fence can resolve. */
export function fencedIdOf(value: string): FencedId | undefined {
  if (parseClockId(value) !== undefined) return { kind: "clock", id: value };
  const kind = kindOfId(value);
  return kind !== undefined && FENCED_ID_KINDS.has(kind) ? { kind: kind as FencedKind, id: value } : undefined;
}

/** Every distinct fenced id under an id-named field of the input, depth-first, capped. */
export function fencedIdsOf(input: unknown): FencedId[] {
  const found = new Map<string, FencedId>();
  const collect = (value: unknown): void => {
    if (typeof value !== "string" || found.size >= MAX_IDS) return;
    const fenced = fencedIdOf(value);
    if (fenced) found.set(`${fenced.kind}:${fenced.id}`, fenced);
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (ID_FIELD.test(key)) {
        if (Array.isArray(child)) child.forEach(collect);
        else collect(child);
      }
      walk(child, depth + 1);
    }
  };
  walk(input, 0);
  return [...found.values()];
}

// `dv-4471-PL-1`, `obs-4471-j03-PL-GROSS_WEIGHT_MISMATCH` → `op-4471`, `op-4471-j03`.
const OPERATION_OF_CHILD = /^(?:dv|obs)-(\d{4}(?:-[a-z0-9]+)?)-(?:CI|PL|CO)-/;

/** The operation a document version or an observation belongs to. */
export function operationOfChildId(id: string): string | undefined {
  const key = OPERATION_OF_CHILD.exec(id)?.[1];
  return key === undefined ? undefined : `op-${key}`;
}

// Worlds that are not a firm's own clock belong to the QA and batch firms (docs/architecture.md §8).
const FIRM_OF_CLOCK_SCOPE = { QA: "firm-qa", SIM: "firm-sim" } as const;

export interface FirmOwnership {
  /** Firm that owns the id; `undefined` when the id does not exist. */
  firmOf(target: FencedId): Promise<string | undefined>;
}

export function createFirmOwnership(connector: Pick<Connector, "operations" | "parties">): FirmOwnership {
  const firmOfOperation = async (operationId: string | undefined) =>
    operationId === undefined ? undefined : (await connector.operations.findOperation(operationId))?.firmId;

  return {
    async firmOf({ kind, id }) {
      switch (kind) {
        case "firm":
          return id;
        case "clock": {
          const parsed = parseClockId(id);
          if (parsed === undefined) return undefined;
          return parsed.firmId ?? (parsed.scope === "QA" || parsed.scope === "SIM" ? FIRM_OF_CLOCK_SCOPE[parsed.scope] : undefined);
        }
        case "operation":
          return firmOfOperation(id);
        case "importer":
          return (await connector.parties.findImporter(id))?.firmId;
        case "supplier":
          return (await connector.parties.findSupplier(id))?.firmId;
        case "docVersion":
        case "observation":
          return firmOfOperation(operationOfChildId(id));
      }
    },
  };
}

/** The first id of `ids` owned by a firm other than `firmId`, resolved one by one in input order. */
export async function crossFirmTarget(firmId: string, ids: readonly FencedId[], ownership: FirmOwnership): Promise<FencedId | undefined> {
  for (const target of ids) {
    const owner = await ownership.firmOf(target);
    if (owner !== undefined && owner !== firmId) return target;
  }
  return undefined;
}
