// The fence of the `QaDriver` (ADR-0005, docs/tool-catalog.md "Acciones del QaDriver", docs/test-plan.md
// §4.1). Before an action runs, the guard resolves the world it touches from ids it reads itself (an
// operation's own `clockId` and `firmId`, never what the caller says they are) and checks:
//
//   1. the firm is of QA type (`firm-qa`, `firm-sim`, `firm-judge-test`) and matches the clock;
//   2. the clock is `qa-*` (every action but `batch.run`), or one of the two fixed QA clocks with its
//      closed list of actions, or a `sim-*` clock of `batch.run`; any other clock is FORBIDDEN;
//   3. every operation the input names belongs to that world.
//
// Console actions (`console.<procedure>`) run the real `appRouter` as a firm-qa user, so an id of
// another firm is left to `firmProcedure`, which refuses it with 403 + `AuditLog DENY CROSS_FIRM`
// before the procedure reads anything (SC-20/3): a call that names only other firms' worlds is such a
// cross-firm probe. An operation of firm-qa must still be of the world the call names.
import { JUDGE_TEST_CLOCK_ID, QA_FIRM_IDS, QA_GLOBAL_CLOCK_ID, ToolError, parseClockId } from "@legajo/shared";
import { fencedIdsOf, firmOfClockId, operationOfChildId } from "../auth/scope";
import { QA_REASON, type QaActionName } from "./contract";
import type { QaParsedInput } from "./contract-inputs";

/** Actions `GLOBAL#firm-qa` admits (SC-20 resets it and reads it; nothing else moves it). */
export const GLOBAL_QA_ACTIONS: readonly string[] = ["wa.inbound", "snapshot", "op.settle", "memory.inspect", "console.clock.reset", "metrics.get"];

/** Actions `JUDGE#firm-judge-test` admits (SC-24 and SC-25 destroy it to test the first sign-in, and read it). */
export const JUDGE_TEST_ACTIONS: readonly string[] = ["world.destroy", "snapshot", "op.settle", "platform.get"];

/** Actions that touch no world at all: they read the stack, never a firm's data. */
export const WORLDLESS_ACTIONS: ReadonlySet<QaActionName> = new Set<QaActionName>(["guardrail.probe", "probe.mocks", "alarm.history"]);

/**
 * Console routers the driver may call (docs/tool-catalog.md); account, tour and activity are the user's
 * own, and the phone simulator's path is `wa.inbound`.
 */
export const CONSOLE_ROUTERS: readonly string[] = ["operations", "dossier", "conversation", "registry", "audit", "metrics", "clock", "escalations", "mailbox"];

/** What an action touches, resolved by the driver from stored data. */
export interface Scope {
  /** Name the closed lists use: the action, or `console.<procedure>`. */
  readonly name: string;
  readonly firmId: string;
  /** `undefined` only for the world-less actions. */
  readonly clockId?: string;
  /** Operations the input names that belong to a QA firm, with the world each one belongs to. */
  readonly operations: readonly ScopedOperation[];
  /** A console call that names only other firms: `firmProcedure` refuses it (CROSS_FIRM) before any read. */
  readonly crossFirmProbe?: true;
}

export interface ScopedOperation {
  readonly operationId: string;
  readonly firmId: string;
  readonly clockId: string;
}

export interface GuardLookups {
  findOperation(operationId: string): Promise<ScopedOperation | undefined>;
}

function forbidden(message: string): ToolError {
  return new ToolError("FORBIDDEN", message, QA_REASON.QA_FENCE);
}

/** The fence proper, over a resolved scope (pure: guard.test.ts drives it case by case). */
export function checkFence(scope: Scope): void {
  if (!QA_FIRM_IDS.includes(scope.firmId)) throw forbidden(`the QA driver only acts on QA firms, not ${scope.firmId}`);
  if (scope.clockId === undefined) {
    if (scope.crossFirmProbe === true && scope.name.startsWith("console.") && scope.firmId === "firm-qa") return;
    if (!WORLDLESS_ACTIONS.has(scope.name as QaActionName)) throw forbidden(`${scope.name} needs a world`);
    return;
  }
  const parsed = parseClockId(scope.clockId);
  if (parsed === undefined) throw new ToolError("INVALID", `invalid clock id "${scope.clockId}"`);
  if (firmOfClockId(scope.clockId) !== scope.firmId) throw forbidden(`the world ${scope.clockId} is not of ${scope.firmId}`);
  if (scope.clockId === QA_GLOBAL_CLOCK_ID) {
    if (!GLOBAL_QA_ACTIONS.includes(scope.name)) throw forbidden(`${scope.name} is not allowed on ${QA_GLOBAL_CLOCK_ID}`);
  } else if (scope.clockId === JUDGE_TEST_CLOCK_ID) {
    if (!JUDGE_TEST_ACTIONS.includes(scope.name)) throw forbidden(`${scope.name} is not allowed on ${JUDGE_TEST_CLOCK_ID}`);
  } else if (parsed.scope === "SIM") {
    if (scope.name !== "batch.run") throw forbidden(`only batch.run acts on a batch world (${scope.clockId})`);
  } else if (parsed.scope !== "QA" || scope.name === "batch.run") {
    throw forbidden(`${scope.name} is not allowed on ${scope.clockId}`);
  }
  for (const operation of scope.operations) {
    if (operation.clockId !== scope.clockId || operation.firmId !== scope.firmId) throw forbidden(`${operation.operationId} is not an operation of ${scope.clockId}`);
  }
}

async function requireOperation(lookups: GuardLookups, operationId: string): Promise<ScopedOperation> {
  const operation = await lookups.findOperation(operationId);
  if (operation === undefined) throw new ToolError("NOT_FOUND", `no operation ${operationId}`);
  return operation;
}

function worldOf(name: string, clockId: string, operations: readonly ScopedOperation[] = []): Scope {
  const firmId = firmOfClockId(clockId);
  if (firmId === undefined) throw new ToolError("INVALID", `invalid clock id "${clockId}"`);
  return { name, firmId, clockId, operations };
}

// Operations (and document versions or observations, through their operation) named anywhere in a
// console input; ids of non-QA firms stay for `firmProcedure` to refuse.
async function consoleScope(procedure: string, input: unknown, lookups: GuardLookups): Promise<Scope> {
  const name = `console.${procedure}`;
  const router = procedure.split(".")[0] ?? "";
  if (!CONSOLE_ROUTERS.includes(router)) throw forbidden(`${name} is not a console procedure the QA driver may call`);
  const walk = fencedIdsOf(input ?? {});
  if (!walk.ok) throw new ToolError("INVALID", `the console input is too large (${walk.limit})`);
  const clocks = walk.ids.filter((id) => id.kind === "clock").map((id) => id.id);
  if (clocks.length > 1) throw new ToolError("INVALID", "a console call acts on one world");
  const operationIds = new Set<string>();
  for (const id of walk.ids) {
    const operationId = id.kind === "operation" ? id.id : id.kind === "docVersion" || id.kind === "observation" ? operationOfChildId(id.id) : undefined;
    if (operationId !== undefined) operationIds.add(operationId);
  }
  const found = (await Promise.all([...operationIds].map((operationId) => lookups.findOperation(operationId)))).filter((operation) => operation !== undefined);
  const ours = found.filter((operation) => QA_FIRM_IDS.includes(operation.firmId));
  const clockId = clocks[0] ?? ours[0]?.clockId;
  const foreign = [...clocks.map(firmOfClockId), ...found.map((operation) => operation.firmId)].some((firmId) => firmId !== undefined && !QA_FIRM_IDS.includes(firmId));
  if (clockId !== undefined && QA_FIRM_IDS.includes(firmOfClockId(clockId) ?? "")) return worldOf(name, clockId, ours);
  if (foreign && ours.length === 0) return { name, firmId: "firm-qa", operations: [], crossFirmProbe: true };
  if (clockId === undefined) throw forbidden(`${name} must name its world (clockId) or an operation of it`);
  return worldOf(name, clockId, ours);
}

function platformScope(input: QaParsedInput<"platform.get">): Scope {
  if (input.firmId !== "firm-qa" && input.firmId !== "firm-judge-test") throw forbidden(`platform.get only reads QA firms, not ${input.firmId}`);
  const clockId = input.clockId ?? (input.firmId === "firm-judge-test" ? JUDGE_TEST_CLOCK_ID : undefined);
  if (clockId === undefined) throw new ToolError("INVALID", "platform.get of firm-qa names the world (clockId)");
  const scope = worldOf("platform.get", clockId);
  if (scope.firmId !== input.firmId) throw forbidden(`the world ${clockId} is not of ${input.firmId}`);
  return scope;
}

/** `world.create` is idempotent by run and scenario: its key must be of the same run and scenario. */
export function checkWorldKey(idempotencyKey: string, input: QaParsedInput<"world.create">): void {
  const [runId, scenario] = idempotencyKey.split("/");
  const sameScenario = scenario === input.scenario || scenario === input.scenario.split("-")[0];
  if (runId !== input.runId || !sameScenario) throw new ToolError("INVALID", "the key of world.create must be of the same run and scenario");
}

/** Resolves what `action` touches from its parsed input and the stored operations. */
export async function resolveScope(action: QaActionName, raw: unknown, lookups: GuardLookups): Promise<Scope> {
  const input = raw as Record<string, unknown>;
  if (WORLDLESS_ACTIONS.has(action)) return { name: action, firmId: "firm-qa", operations: [] };
  if (action === "console") {
    const call = raw as QaParsedInput<"console">;
    return consoleScope(call.procedure, call.input, lookups);
  }
  if (action === "world.create") {
    const world = raw as QaParsedInput<"world.create">;
    return worldOf(action, `qa-${world.runId}-${world.scenario}`);
  }
  if (action === "batch.run") return worldOf(action, `sim-${(raw as QaParsedInput<"batch.run">).batchId}`);
  if (action === "platform.get") return platformScope(raw as QaParsedInput<"platform.get">);
  const operationId = typeof input.operationId === "string" ? input.operationId : undefined;
  const namedClock = typeof input.clockId === "string" ? input.clockId : undefined;
  if (operationId !== undefined) {
    const operation = await requireOperation(lookups, operationId);
    if (namedClock !== undefined && namedClock !== operation.clockId) throw forbidden(`${operationId} is not an operation of ${namedClock}`);
    return worldOf(action, operation.clockId, [operation]);
  }
  if (namedClock !== undefined) return worldOf(action, namedClock);
  throw new ToolError("INVALID", `${action} names no world`);
}
