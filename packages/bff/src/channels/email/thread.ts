// Which operation an `op-<number>-<tag>@legajo.demo.craftech.io` address belongs to
// (docs/architecture-integrations.md §1-§2): `Operations GSI2 THREAD#<number>-<tag>`, then the tag is
// verified again by HMAC with the `thread` subkey against the operation's number, clock and epoch, and
// the epoch must not be tombstoned (`Runtime/TOMB#<clockId>#<epoch>`: a reset or a seed reload).
// `InboundEmail` discards whatever does not resolve before any other work, and the SES client's fence
// uses the same answer for the `SIMULATOR` and `QA` profiles.
//
// A miss is `UNKNOWN` when the number cannot hold an operation (outside every firm's range, or a QA
// number without a live `LEASE#OPNUM#`) and `INVALID` otherwise: a number in use whose tag does not
// resolve, the tag of another world or epoch, or a forged one.
import { type ThreadTagInput, operationNumberRange, parseThreadAddress, verifyThreadTag } from "@legajo/shared";
import type { IdentityLookup, OperationsPort } from "../../connector/ports";
import type { WorldPort } from "../../connector/ports-runtime";
import { isExpired } from "../../domain/common";
import type { Operation } from "../../domain/operations";

export type ThreadResolution =
  | { readonly status: "RESOLVED"; readonly operation: Operation }
  | { readonly status: "TOMBSTONED"; readonly operation: Operation }
  | { readonly status: "INVALID" | "UNKNOWN" }
  /** Not of the `op-<number>-<tag>@legajo.demo.craftech.io` form at all. */
  | { readonly status: "NOT_THREAD" };

export interface ThreadDeps {
  readonly operations: Pick<OperationsPort, "findOperationByThread">;
  readonly world: Pick<WorldPort, "isTombstoned" | "getLease">;
  /** HKDF `thread` subkey of `SessionTokenKey` (lib/secrets.ts `subkey("thread")`). */
  readonly threadKey: Uint8Array;
  /** Real clock: a lapsed lease does not make a number live. */
  readonly now: () => Date;
}

async function numberInUse(deps: ThreadDeps, operationNumber: string): Promise<boolean> {
  const range = operationNumberRange(operationNumber);
  if (range === undefined) return false;
  if (range !== "qa") return true;
  const lease = await deps.world.getLease("OPNUM", String(Number(operationNumber)));
  return lease !== undefined && !isExpired(lease.expiresAt, deps.now());
}

async function tagVerifies(deps: ThreadDeps, operation: Operation, tag: string): Promise<boolean> {
  const input: ThreadTagInput = { operationNumber: operation.operationNumber, clockId: operation.clockId, worldEpoch: operation.worldEpoch };
  return verifyThreadTag(deps.threadKey, input, tag);
}

export async function resolveThread(deps: ThreadDeps, address: string): Promise<ThreadResolution> {
  const parsed = parseThreadAddress(address);
  if (parsed === undefined) return { status: "NOT_THREAD" };
  const found: IdentityLookup<Operation> = await deps.operations.findOperationByThread(parsed.operationNumber, parsed.threadTag);
  if (found.status === "UNIQUE") {
    const operation = found.value;
    if (operation.threadAddress !== address || !(await tagVerifies(deps, operation, parsed.threadTag))) return { status: "INVALID" };
    const tombstoned = await deps.world.isTombstoned(operation.clockId, operation.worldEpoch);
    return tombstoned ? { status: "TOMBSTONED", operation } : { status: "RESOLVED", operation };
  }
  // Two operations on one thread key would be a broken uniqueness claim: never pick one.
  if (found.status === "AMBIGUOUS") return { status: "INVALID" };
  return (await numberInUse(deps, parsed.operationNumber)) ? { status: "INVALID" } : { status: "UNKNOWN" };
}
