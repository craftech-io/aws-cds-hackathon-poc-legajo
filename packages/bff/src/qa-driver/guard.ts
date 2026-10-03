// The fence of the `QaDriver` (ADR-0005, docs/tool-catalog.md "Acciones del QaDriver", docs/test-plan.md
// §4.1). Before an action runs, the guard resolves the world it touches from ids it reads itself (an
// operation's own `clockId` and `firmId`, never what the caller says they are) and checks:
//
//   1. the firm is of QA type (`firm-qa`, `firm-sim`, `firm-guest-test`) and matches the clock;
//   2. the clock is `qa-*` (every action but `batch.run`), or one of the two fixed QA clocks with its
//      closed list of actions, or a `sim-*` clock of `batch.run`; any other clock is FORBIDDEN;
//   3. every operation, importer and supplier the input names belongs to that world (firm and clock);
//      a Memory actor (`<importerId>-e<epoch>`) is one of an importer of that world, of an epoch the
//      world already reached (SC-20 inspects the actor of a past epoch of `GLOBAL#firm-qa`).
//
// Console actions (`console.<procedure>`) run the real `appRouter` as a firm-qa user, so an id of
// another firm is left to `firmProcedure`, which refuses it with 403 + `AuditLog DENY CROSS_FIRM`
// before the procedure reads anything (SC-20/3): a call that names only other firms' worlds is such a
// cross-firm probe. An operation or a party of a QA firm must still be of the world the call names:
// firm-qa owns `GLOBAL#firm-qa` and every `qa-*` world, so `firmProcedure` alone cannot tell them apart.
import { GUEST_TEST_CLOCK_ID, QA_FIRM_IDS, QA_GLOBAL_CLOCK_ID, ToolError, parseClockId } from "@legajo/shared";
import { type FencedId, fencedIdsOf, firmOfClockId, operationOfChildId } from "../auth/scope";
import { QA_REASON, type QaActionName } from "./contract";
import type { QaParsedInput } from "./contract-inputs";

/** Actions `GLOBAL#firm-qa` admits (SC-20 resets it and reads it; nothing else moves it). */
export const GLOBAL_QA_ACTIONS: readonly string[] = ["wa.inbound", "snapshot", "op.settle", "memory.inspect", "console.clock.reset", "metrics.get"];

/** Actions `GUEST#firm-guest-test` admits (SC-24 and SC-25 destroy it to test the first sign-in, and read it). */
export const GUEST_TEST_ACTIONS: readonly string[] = ["world.destroy", "snapshot", "op.settle", "platform.get"];

/** Actions that touch no world at all: they read the stack, never a firm's data. */
export const WORLDLESS_ACTIONS: ReadonlySet<QaActionName> = new Set<QaActionName>(["guardrail.probe", "probe.mocks", "alarm.history"]);

/**
 * SC-26's actions of the public sign-up (docs/test-plan.md §4.1): no world and no firm id in their
 * input; their own fence is the `qa-signup-<runId>-<key>` mailbox they build (signup-fence.ts).
 */
export const SIGNUP_ACTIONS: ReadonlySet<QaActionName> = new Set<QaActionName>(["signup.readCode", "lead.inspect", "lead.purge"]);

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
  /** Importers and suppliers the input names that belong to a QA firm, with their world. */
  readonly parties?: readonly ScopedParty[];
  /** Memory actors the input names (`memory.inspect`); each one's importer is in `parties`. */
  readonly actors?: readonly ScopedActor[];
  /** A console call that names only other firms: `firmProcedure` refuses it (CROSS_FIRM) before any read. */
  readonly crossFirmProbe?: true;
  /** Of a console call: whether the procedure is a query or a mutation. */
  readonly procedureKind?: "query" | "mutation" | "subscription";
}

export interface ScopedOperation {
  readonly operationId: string;
  readonly firmId: string;
  readonly clockId: string;
}

export interface ScopedParty {
  readonly kind: "importer" | "supplier";
  readonly id: string;
  readonly firmId: string;
  readonly clockId: string;
}

export interface ScopedActor {
  readonly actorId: string;
  readonly importerId: string;
  readonly epoch: number;
  /** Current epoch of the fenced world; absent when its clock does not exist. */
  readonly worldEpoch?: number;
}

export interface GuardLookups {
  findOperation(operationId: string): Promise<ScopedOperation | undefined>;
  findImporter(importerId: string): Promise<ScopedParty | undefined>;
  findSupplier(supplierId: string): Promise<ScopedParty | undefined>;
  worldEpochOf(clockId: string): Promise<number | undefined>;
  /** Query or mutation of a console procedure (console.ts `procedureKind`). */
  procedureKind?(procedure: string): "query" | "mutation" | "subscription" | undefined;
}

/** Memory actor of an importer in one world epoch (docs/architecture.md §9.1): `<importerId>-e<worldEpoch>`. */
const MEMORY_ACTOR = /^(imp-[A-Za-z0-9-]+)-e(\d{1,9})$/;

function forbidden(message: string): ToolError {
  return new ToolError("FORBIDDEN", message, QA_REASON.QA_FENCE);
}

/** The fence proper, over a resolved scope (pure: guard.test.ts drives it case by case). */
export function checkFence(scope: Scope): void {
  if (!QA_FIRM_IDS.includes(scope.firmId)) throw forbidden(`the QA driver only acts on QA firms, not ${scope.firmId}`);
  if (scope.clockId === undefined) {
    // A cross-firm probe only reads (SC-20/3): a mutation naming another firm's ids never reaches a router.
    if (scope.crossFirmProbe === true && scope.name.startsWith("console.") && scope.firmId === "firm-qa") {
      if (scope.procedureKind !== "query") throw forbidden(`${scope.name} names only other firms' ids and is not a query`);
      return;
    }
    if (!WORLDLESS_ACTIONS.has(scope.name as QaActionName) && !SIGNUP_ACTIONS.has(scope.name as QaActionName)) throw forbidden(`${scope.name} needs a world`);
    return;
  }
  const parsed = parseClockId(scope.clockId);
  if (parsed === undefined) throw new ToolError("INVALID", `invalid clock id "${scope.clockId}"`);
  if (firmOfClockId(scope.clockId) !== scope.firmId) throw forbidden(`the world ${scope.clockId} is not of ${scope.firmId}`);
  if (scope.clockId === QA_GLOBAL_CLOCK_ID) {
    if (!GLOBAL_QA_ACTIONS.includes(scope.name)) throw forbidden(`${scope.name} is not allowed on ${QA_GLOBAL_CLOCK_ID}`);
  } else if (scope.clockId === GUEST_TEST_CLOCK_ID) {
    if (!GUEST_TEST_ACTIONS.includes(scope.name)) throw forbidden(`${scope.name} is not allowed on ${GUEST_TEST_CLOCK_ID}`);
  } else if (parsed.scope === "SIM") {
    if (scope.name !== "batch.run") throw forbidden(`only batch.run acts on a batch world (${scope.clockId})`);
  } else if (parsed.scope !== "QA" || scope.name === "batch.run") {
    throw forbidden(`${scope.name} is not allowed on ${scope.clockId}`);
  }
  for (const operation of scope.operations) {
    if (operation.clockId !== scope.clockId || operation.firmId !== scope.firmId) throw forbidden(`${operation.operationId} is not an operation of ${scope.clockId}`);
  }
  const parties = scope.parties ?? [];
  for (const party of parties) {
    if (party.clockId !== scope.clockId || party.firmId !== scope.firmId) throw forbidden(`${party.id} is not a party of ${scope.clockId}`);
    // World-factory ids embed the world (`imp-qa-<runId>-<scenario>-<key>`): a cheap second check.
    if (parsed.scope === "QA" && party.kind === "importer" && !party.id.startsWith(`imp-${scope.clockId}-`)) throw forbidden(`${party.id} is not an importer of ${scope.clockId}`);
  }
  for (const actor of scope.actors ?? []) {
    const ownImporter = parties.some((party) => party.kind === "importer" && party.id === actor.importerId);
    if (!ownImporter || actor.worldEpoch === undefined || actor.epoch > actor.worldEpoch) throw forbidden(`${actor.actorId} is not a Memory actor of ${scope.clockId}`);
  }
}

async function requireOperation(lookups: GuardLookups, operationId: string): Promise<ScopedOperation> {
  const operation = await lookups.findOperation(operationId);
  if (operation === undefined) throw new ToolError("NOT_FOUND", `no operation ${operationId}`);
  return operation;
}

function worldOf(name: string, clockId: string, operations: readonly ScopedOperation[] = [], parties: readonly ScopedParty[] = []): Scope {
  const firmId = firmOfClockId(clockId);
  if (firmId === undefined) throw new ToolError("INVALID", `invalid clock id "${clockId}"`);
  return { name, firmId, clockId, operations, parties };
}

const isQaFirm = (firmId: string | undefined): boolean => firmId !== undefined && QA_FIRM_IDS.includes(firmId);

async function partiesOf(ids: readonly FencedId[], lookups: GuardLookups): Promise<ScopedParty[]> {
  const found = await Promise.all(
    ids.map((id) => (id.kind === "importer" ? lookups.findImporter(id.id) : id.kind === "supplier" ? lookups.findSupplier(id.id) : Promise.resolve(undefined))),
  );
  return found.filter((party) => party !== undefined);
}

// Operations (and document versions or observations, through their operation), importers and
// suppliers named anywhere in a console input; ids of non-QA firms stay for `firmProcedure` to refuse.
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
  const parties = await partiesOf(walk.ids, lookups);
  const ours = found.filter((operation) => isQaFirm(operation.firmId));
  const ourParties = parties.filter((party) => isQaFirm(party.firmId));
  const clockId = clocks[0] ?? ours[0]?.clockId ?? ourParties[0]?.clockId;
  const firms = [...clocks.map(firmOfClockId), ...found.map((operation) => operation.firmId), ...parties.map((party) => party.firmId)];
  const foreign = firms.some((firmId) => firmId !== undefined && !isQaFirm(firmId));
  if (clockId !== undefined && isQaFirm(firmOfClockId(clockId))) return worldOf(name, clockId, ours, ourParties);
  if (foreign && ours.length === 0 && ourParties.length === 0) {
    const kind = lookups.procedureKind?.(procedure);
    return { name, firmId: "firm-qa", operations: [], crossFirmProbe: true, ...(kind === undefined ? {} : { procedureKind: kind }) };
  }
  if (clockId === undefined) throw forbidden(`${name} must name its world (clockId) or an operation of it`);
  return worldOf(name, clockId, ours, ourParties);
}

// `memory.inspect` of an actor by id: the actor's importer is read from `Parties` and must be of the
// fenced world, and its epoch one the world already reached; anything else is FORBIDDEN (checkFence).
async function withActor(scope: Scope, actorId: string, lookups: GuardLookups): Promise<Scope> {
  const match = MEMORY_ACTOR.exec(actorId);
  const importerId = match?.[1];
  if (importerId === undefined || scope.clockId === undefined) throw forbidden(`${actorId} is not a Memory actor of a QA world`);
  const importer = await lookups.findImporter(importerId);
  if (importer === undefined) throw forbidden(`${actorId} is not a Memory actor of ${scope.clockId}`);
  const worldEpoch = await lookups.worldEpochOf(scope.clockId);
  const actor: ScopedActor = { actorId, importerId, epoch: Number(match?.[2]), ...(worldEpoch === undefined ? {} : { worldEpoch }) };
  return { ...scope, parties: [...(scope.parties ?? []), importer], actors: [actor] };
}

function platformScope(input: QaParsedInput<"platform.get">): Scope {
  if (input.firmId !== "firm-qa" && input.firmId !== "firm-guest-test") throw forbidden(`platform.get only reads QA firms, not ${input.firmId}`);
  const clockId = input.clockId ?? (input.firmId === "firm-guest-test" ? GUEST_TEST_CLOCK_ID : undefined);
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
  if (WORLDLESS_ACTIONS.has(action) || SIGNUP_ACTIONS.has(action)) return { name: action, firmId: "firm-qa", operations: [] };
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
  const scope = await namedWorld(action, input, lookups);
  const actorId = action === "memory.inspect" && typeof input.actorId === "string" ? input.actorId : undefined;
  return actorId === undefined ? scope : withActor(scope, actorId, lookups);
}

/** The world of an action that names an operation or a clock (the operation's own clock wins). */
async function namedWorld(action: QaActionName, input: Record<string, unknown>, lookups: GuardLookups): Promise<Scope> {
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
