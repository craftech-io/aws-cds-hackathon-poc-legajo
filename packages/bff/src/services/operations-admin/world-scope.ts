// Which world a console change acts on, and the ids a world gives its records (docs/architecture.md §8,
// docs/seed-spec.md §2 and §14):
//
//   - a registry change names its world (`clockId`), or the firm's only world when it has one; `firm-qa`
//     owns many and must name it; a world of another firm is refused by the fence;
//   - an operation of a guest world carries the world's tag (`op-4471-g03`), so the same number lives
//     in every guest world without two operations sharing an id; demo and QA numbers are unique already
//     (each firm has its range, QA numbers are leased);
//   - the KPI row a human action counts on is the dossier's in its world (`BATCH` for `sim-*`).
import { ToolError, operationId as operationIdOf, parseClockId } from "@legajo/shared";
import { firmOfClockId } from "../../auth/scope";
import type { KpiRef } from "../../connector/ports-runtime";
import type { Operation } from "../../domain/operations";
import type { DirectContext } from "./handler-kit";

/** The world of a registry change: the one named (fenced to the caller's firm) or the firm's own. */
export async function registryWorld(ctx: DirectContext<unknown>, firmId: string, clockId: string | undefined): Promise<string> {
  if (clockId !== undefined) {
    await ctx.fence(firmOfClockId(clockId) ?? "", { kind: "clock", id: clockId });
    if (firmOfClockId(clockId) !== firmId) throw new ToolError("INVALID", "the world is not of this firm", "WORLD_NOT_OF_FIRM");
    return clockId;
  }
  const firm = await ctx.connector.firms.getFirm(firmId);
  if (firm.clockId === undefined) throw new ToolError("INVALID", "this firm has several worlds: name the one to change", "WORLD_REQUIRED");
  return firm.clockId;
}

/** `g03` for `GUEST#firm-guest-03`, `gtest` for `GUEST#firm-guest-test`; nothing for the other worlds. */
export function guestWorldTag(clockId: string): string | undefined {
  const parsed = parseClockId(clockId);
  if (parsed?.scope !== "GUEST" || parsed.firmId === undefined) return undefined;
  return `g${parsed.firmId.slice("firm-guest-".length)}`;
}

/** `op-<number>` in a demo, QA or batch world; `op-<number>-g<nn>` in a guest world. */
export function operationIdInWorld(operationNumber: string, clockId: string): string {
  return operationIdOf(operationNumber, guestWorldTag(clockId));
}

/** The KPI row of an operation in its world. */
export function kpiRefOf(operation: { readonly firmId: string; readonly clockId: string; readonly operationId: string }): KpiRef {
  return { firmId: operation.firmId, source: parseClockId(operation.clockId)?.scope === "SIM" ? "BATCH" : "WORLD", clockId: operation.clockId, operationId: operation.operationId };
}

/** The operation a console action is about, fenced to the caller's firm (403 and `DENY CROSS_FIRM` otherwise). */
export async function fencedOperation(ctx: DirectContext<unknown>, operationId: string): Promise<Operation> {
  const operation = await ctx.connector.operations.getOperation(operationId);
  await ctx.fence(operation.firmId, { kind: "operation", id: operation.operationId });
  return operation;
}
