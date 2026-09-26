// The operation a tool call acts on, and `LAM-OP-SCOPE` (docs/design-brief.md §5.6, docs/tool-catalog.md
// "Sesión"): operation, firm, importer, supplier and clock come from the session of the turn (or, for a
// direct caller, from the operation it named), never from what the model wrote; and no id in the input
// is accepted unless it belongs to that operation.
//
// The check walks the parsed input and classifies every string by its id prefix, whatever the field is
// called (the same idea as the console's firm fence, auth/scope.ts), so a field added later is fenced
// without touching this file:
//
//   firm, operation, importer, supplier   equal to the scope's own
//   docVersion `dv-<op>-…`, observation   embed the scope's operation key (`4471`, `4471-j03`)
//   `obs-<op>-…`
//   contact `ctc-…`                        a contact of the scope's supplier (registry lookup)
//   message `msg-…`                        a message of the scope's operation (conversation lookup)
//   broker `brk-…`                         never: no Gateway tool takes a broker
//   a field named `operationNumber`        the scope's number
//
// The walk is bounded and fails closed: an input deeper or with more ids than any tool declares is
// refused whole, never checked in part.
import { DOC_TYPE_SHORT, type IdKind, ID_SPEC, kindOfId, operationKey, operationNumberOf } from "@legajo/shared";
import type { Connector } from "../../connector/connector";

export interface ToolScope {
  readonly operationId: string;
  readonly operationNumber: string;
  readonly firmId: string;
  readonly importerId: string;
  readonly supplierId: string;
  readonly clockId: string;
  /**
   * "Now" of every rule of the call: the simulated instant of the event that opened the turn, or the
   * world's simulated now for a direct caller (ADR-0007). Never the machine clock.
   */
  readonly nowSim: string;
}

/** What a session or an operation row says about the call's operation. */
export interface ScopeSource {
  readonly operationId: string;
  readonly firmId: string;
  readonly importerId: string;
  readonly supplierId: string;
  readonly clockId: string;
}

export function toolScope(source: ScopeSource, nowSim: string): ToolScope {
  return {
    operationId: source.operationId,
    operationNumber: operationNumberOf(source.operationId),
    firmId: source.firmId,
    importerId: source.importerId,
    supplierId: source.supplierId,
    clockId: source.clockId,
    nowSim,
  };
}

export type ScopedKind = IdKind | "operationNumber";

export interface ScopedRef {
  readonly kind: ScopedKind;
  readonly value: string;
  /** Where it was found (`refs.observationIds.1`); ids are not personal data, so audits may carry it. */
  readonly path: string;
}

/** Tool inputs are small and flat; anything past these bounds is refused whole. */
export const SCOPE_WALK_LIMITS = { depth: 6, refs: 40 } as const;

export type ScopeWalk = { readonly ok: true; readonly refs: ScopedRef[] } | { readonly ok: false; readonly limit: keyof typeof SCOPE_WALK_LIMITS };

/** Every value of the input that names something of an operation, depth-first. */
export function scopedRefsOf(input: unknown): ScopeWalk {
  const refs: ScopedRef[] = [];
  let broken: keyof typeof SCOPE_WALK_LIMITS | undefined;
  const add = (ref: ScopedRef): void => {
    if (refs.length >= SCOPE_WALK_LIMITS.refs) broken ??= "refs";
    else refs.push(ref);
  };
  const visit = (value: unknown, path: string, depth: number, key: string | undefined): void => {
    if (broken !== undefined) return;
    if (depth > SCOPE_WALK_LIMITS.depth) {
      broken = "depth";
      return;
    }
    if (typeof value === "string") {
      const kind = kindOfId(value);
      if (kind !== undefined) add({ kind, value, path });
      else if (key === "operationNumber") add({ kind: "operationNumber", value, path });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, join(path, String(index)), depth + 1, key));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [child, item] of Object.entries(value)) visit(item, join(path, child), depth + 1, child);
    }
  };
  visit(input, "", 0, undefined);
  return broken === undefined ? { ok: true, refs } : { ok: false, limit: broken };
}

function join(path: string, segment: string): string {
  return path === "" ? segment : `${path}.${segment}`;
}

const DOC_SHORTS = Object.values(DOC_TYPE_SHORT);

/** `dv-4471-PL-1` or `obs-4471-PL-…` of the operation `op-4471` (and not of its clone `op-4471-j03`). */
export function embedsOperation(id: string, kind: "docVersion" | "observation", operationId: string): boolean {
  const prefix = `${ID_SPEC[kind].prefix}-${operationKey(operationId)}-`;
  if (!id.startsWith(prefix)) return false;
  const rest = id.slice(prefix.length);
  return DOC_SHORTS.some((short) => rest.startsWith(`${short}-`));
}

/** Registry reads the scope needs for the ids it cannot judge by their shape. */
export interface ScopeLookups {
  isContactOfSupplier(supplierId: string, contactId: string): Promise<boolean>;
  isMessageOfOperation(operationId: string, messageId: string): Promise<boolean>;
}

export function connectorLookups(connector: Connector): ScopeLookups {
  return {
    isContactOfSupplier: async (supplierId, contactId) => (await connector.parties.findContact(supplierId, contactId)) !== undefined,
    isMessageOfOperation: async (operationId, messageId) => (await connector.conversations.getMessage(operationId, messageId)) !== undefined,
  };
}

export type ScopeViolation =
  | { readonly reason: "OUT_OF_SCOPE"; readonly ref: ScopedRef; readonly why: string }
  | { readonly reason: "INPUT_TOO_LARGE"; readonly limit: keyof typeof SCOPE_WALK_LIMITS };

async function refViolation(scope: ToolScope, ref: ScopedRef, lookups: ScopeLookups): Promise<string | undefined> {
  switch (ref.kind) {
    case "firm":
      return ref.value === scope.firmId ? undefined : "belongs to another firm";
    case "operation":
      return ref.value === scope.operationId ? undefined : "is another operation";
    case "operationNumber":
      return ref.value === scope.operationNumber ? undefined : "is another operation number";
    case "importer":
      return ref.value === scope.importerId ? undefined : "is not the importer of this operation";
    case "supplier":
      return ref.value === scope.supplierId ? undefined : "is not the supplier of this operation";
    case "docVersion":
    case "observation":
      return embedsOperation(ref.value, ref.kind, scope.operationId) ? undefined : "belongs to another operation";
    case "contact":
      return (await lookups.isContactOfSupplier(scope.supplierId, ref.value)) ? undefined : "is not a contact of the supplier of this operation";
    case "message":
      return (await lookups.isMessageOfOperation(scope.operationId, ref.value)) ? undefined : "is not a message of this operation";
    case "broker":
      return "no Gateway tool takes a broker id";
  }
}

/** The first id of the input that does not belong to the scope's operation, or `undefined`. */
export async function scopeViolation(scope: ToolScope, input: unknown, lookups: ScopeLookups): Promise<ScopeViolation | undefined> {
  const walk = scopedRefsOf(input);
  if (!walk.ok) return { reason: "INPUT_TOO_LARGE", limit: walk.limit };
  for (const ref of walk.refs) {
    const why = await refViolation(scope, ref, lookups);
    if (why !== undefined) return { reason: "OUT_OF_SCOPE", ref, why };
  }
  return undefined;
}
