// The firm fence of the console (docs/architecture.md §10, FL-082): every id a request carries is
// checked against the firm of the principal before the procedure runs. `firmProcedure`
// (routers/trpc.ts) walks the raw input, classifies every string (values and keys, whatever the
// field is called), resolves which firm owns each id and refuses the whole request with 403 +
// `AuditLog DENY CROSS_FIRM` when one belongs to another firm. The walk fails closed: an input too
// deep, too large or naming too many ids is refused whole (`AuditLog DENY INPUT_TOO_LARGE`), never
// checked in part. An id that does not exist is not this fence's business: the procedure answers
// NOT_FOUND or creates it.
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

// The walk is bounded: console inputs are small, and a hostile one must not buy unbounded lookups.
// Past any bound the request is refused, so no id ever escapes the check.
export const FENCE_LIMITS = { depth: 6, ids: 50, nodes: 5_000 } as const;

export type FenceLimit = keyof typeof FENCE_LIMITS;

/** Every fenced id of the input, or the bound it broke. */
export type FenceWalk = { readonly ok: true; readonly ids: FencedId[] } | { readonly ok: false; readonly limit: FenceLimit };

/** Classifies one value; `undefined` when it is not an id this fence can resolve. */
export function fencedIdOf(value: string): FencedId | undefined {
  if (parseClockId(value) !== undefined) return { kind: "clock", id: value };
  const kind = kindOfId(value);
  return kind !== undefined && FENCED_ID_KINDS.has(kind) ? { kind: kind as FencedKind, id: value } : undefined;
}

/** Every distinct fenced id among the strings of the input (values and keys), depth-first, bounded. */
export function fencedIdsOf(input: unknown): FenceWalk {
  const found = new Map<string, FencedId>();
  let nodes = 0;
  let broken: FenceLimit | undefined;
  const collect = (value: string): void => {
    const fenced = fencedIdOf(value);
    if (fenced === undefined) return;
    found.set(`${fenced.kind}:${fenced.id}`, fenced);
    if (found.size > FENCE_LIMITS.ids) broken = "ids";
  };
  const walk = (value: unknown, depth: number): void => {
    if (broken !== undefined) return;
    nodes += 1;
    if (nodes > FENCE_LIMITS.nodes) {
      broken = "nodes";
      return;
    }
    if (typeof value === "string") return collect(value);
    if (value === null || typeof value !== "object") return;
    if (depth > FENCE_LIMITS.depth) {
      broken = "depth";
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (!Array.isArray(value)) collect(key);
      walk(child, depth + 1);
    }
  };
  walk(input, 0);
  return broken === undefined ? { ok: true, ids: [...found.values()] } : { ok: false, limit: broken };
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

/** The firm a world belongs to: the one a GLOBAL or JUDGE clock names, `firm-qa` for `qa-*`, `firm-sim` for `sim-*`. */
export function firmOfClockId(clockId: string): string | undefined {
  const parsed = parseClockId(clockId);
  if (parsed === undefined) return undefined;
  return parsed.firmId ?? (parsed.scope === "QA" || parsed.scope === "SIM" ? FIRM_OF_CLOCK_SCOPE[parsed.scope] : undefined);
}

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
        case "clock":
          return firmOfClockId(id);
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
