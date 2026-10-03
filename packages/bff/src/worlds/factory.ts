// The world factory (`create_world`, docs/seed-spec.md §14, docs/architecture.md §8): demo worlds
// (seed:load), guest worlds (`WorldJanitor GUEST_CREATE`), QA runs (`QaDriver world.create`) and metrics
// batches. Idempotent by clock: a world whose clock exists is answered as it is (`created: false`).
// A creation that fell over before its clock was written leaves "restos" (items, claims): the next
// call deletes them first, then writes the world at a new epoch from `COUNTER#EPOCH#<clockId>` (ADD:
// 1 only the first time the clock exists, never back, never reused after a destroy), and creates the
// clock last, PAUSED at the world's start (`attribute_not_exists`). `reloadWorld` is the part of a
// reset that belongs to the factory (clock/reset.ts `WorldRebuild.reload`).
import { ConnectorError, ToolError } from "@legajo/shared";
import { purgeWorldItems } from "../clock/world-items";
import type { Clock } from "../domain/world-state";
import type { WorldsDeps } from "./deps";
import { addressHashOf } from "./instantiate";
import type { ClonedOperation } from "./clones";
import { type WorldPlan, type WorldRequest, clockOfRequest, planFromModels, planFromTemplate } from "./plan";
import { type WrittenOperation, writeWorld } from "./write";

/** Seeded history goes back this far before the start of a world (its `AuditLog` months). */
const SEEDED_HISTORY_MS = 31 * 24 * 60 * 60_000;

export interface CreatedOperation extends ClonedOperation {
  readonly threadAddress: string;
}

export interface CreatedWorld {
  readonly clockId: string;
  readonly firmId: string;
  readonly worldEpoch: number;
  readonly created: boolean;
  readonly startAtSim: string;
  readonly operations: readonly CreatedOperation[];
  readonly firmMailbox: string;
}

async function planOf(request: WorldRequest, deps: WorldsDeps): Promise<WorldPlan> {
  if (request.kind === "DEMO" || request.kind === "GUEST") return planFromTemplate(await deps.templates.read(request.kind === "DEMO" ? request.template : "guest"), request);
  const atReal = deps.now().toISOString();
  const clockId = clockOfRequest(request);
  const take = (kind: "PHONE" | "OPNUM", value: string) => deps.data.world.acquireLease({ kind, value, holder: clockId, atReal });
  return planFromModels(await deps.templates.read("models"), request, take, deps.now());
}

function joinThreads(planned: readonly ClonedOperation[], written: readonly WrittenOperation[]): CreatedOperation[] {
  const byId = new Map(written.map((operation) => [operation.operationId, operation]));
  return planned.map((operation) => ({ ...operation, threadAddress: byId.get(operation.operationId)?.threadAddress ?? "" }));
}

/** Deletes whatever a creation that fell over left of the world (its clock never got written). */
async function deleteRestos(plan: WorldPlan, deps: WorldsDeps): Promise<void> {
  const start = Date.parse(plan.startAtSim);
  await purgeWorldItems(
    { clockId: plan.clockId, firmId: plan.firmId, fromSim: new Date(start - SEEDED_HISTORY_MS).toISOString(), toSim: new Date(start + SEEDED_HISTORY_MS).toISOString(), mailboxes: [plan.firmMailbox] },
    { client: deps.client, data: deps.data, addressHash: (address) => addressHashOf(deps.keys, address) },
  );
}

/** The answer for a world that already exists: its operations as stored, matched to the request's keys by number. */
async function describeExisting(clock: Clock, request: WorldRequest, deps: WorldsDeps): Promise<CreatedWorld> {
  const stored = (await deps.data.operations.listOperations(clock.firmId, { clockId: clock.clockId })).sort((a, b) => a.operationNumber.localeCompare(b.operationNumber));
  const keys = request.kind === "QA" || request.kind === "BATCH" ? request.entries.map((entry) => entry.key) : stored.map((operation) => operation.operationId);
  const operations: CreatedOperation[] = [];
  for (const [index, operation] of stored.entries()) {
    const contacts = (await deps.data.parties.listContacts(operation.supplierId)).map((contact) => ({ contactId: contact.contactId, email: contact.email, status: contact.status }));
    operations.push({ key: keys[index] ?? operation.operationId, operationId: operation.operationId, operationNumber: operation.operationNumber, importerId: operation.importerId, supplierId: operation.supplierId, contacts, threadAddress: operation.threadAddress });
  }
  const firm = await deps.data.firms.findFirm(clock.firmId);
  const firmMailbox = clock.clockId.startsWith("qa-") ? `estudio-${clock.clockId}@sim.legajo.demo.craftech.io` : (firm?.mailboxAddress ?? "");
  return { clockId: clock.clockId, firmId: clock.firmId, worldEpoch: clock.worldEpoch, created: false, startAtSim: clock.startAtSim, operations, firmMailbox };
}

/** Creates the world a request names, or answers the one that exists (see the header). */
export async function createWorld(request: WorldRequest, deps: WorldsDeps): Promise<CreatedWorld> {
  const clockId = clockOfRequest(request);
  const existing = await deps.data.world.findClock(clockId);
  if (existing !== undefined) return describeExisting(existing, request, deps);

  const plan = await planOf(request, deps);
  try {
    await deleteRestos(plan, deps);
    const worldEpoch = await deps.data.world.nextEpoch(clockId);
    const written = await writeWorld(plan, worldEpoch, deps);
    await deps.data.world.createClock({
      clockId,
      firmId: plan.firmId,
      mode: "PAUSED",
      offsetMs: 0,
      pausedSimNow: plan.startAtSim,
      startAtSim: plan.startAtSim,
      worldEpoch,
      template: plan.template,
      ...(plan.settings === undefined ? {} : { settings: plan.settings }),
      synthetic: true,
      ...(plan.stamp.world === undefined ? {} : { world: plan.stamp.world }),
      ...(plan.stamp.runId === undefined ? {} : { runId: plan.stamp.runId }),
      ...(plan.stamp.expiresAt === undefined ? {} : { expiresAt: plan.stamp.expiresAt }),
    });
    await deps.data.audit.record({
      firmId: plan.firmId,
      decision: "ACTION",
      action: "WORLD_CREATED",
      actor: "SYSTEM",
      clockId,
      atSim: plan.startAtSim,
      atReal: deps.now().toISOString(),
      detail: { worldEpoch, template: plan.template, operations: written.operations.length, ...written.counts },
    });
    deps.log.info("worlds.created", { clockId, worldEpoch, template: plan.template, operations: written.operations.length });
    return { clockId, firmId: plan.firmId, worldEpoch, created: true, startAtSim: plan.startAtSim, operations: joinThreads(plan.operations, written.operations), firmMailbox: plan.firmMailbox };
  } catch (error) {
    // A concurrent creation of the same clock won the clock row: answer that world.
    if (error instanceof ConnectorError && error.code === "CONFLICT") {
      const won = await deps.data.world.findClock(clockId);
      if (won !== undefined) return describeExisting(won, request, deps);
    }
    for (const lease of plan.leases) await deps.data.world.releaseLease({ kind: lease.kind, value: lease.value, holder: clockId });
    throw error;
  }
}

/** The request that rebuilds an existing clock's world from its template (demo and guest worlds only). */
export function rebuildRequest(clockId: string, firmId: string, importerPhones?: Readonly<Record<string, string>>): WorldRequest {
  if (clockId.startsWith("GUEST#")) return { kind: "GUEST", firmId };
  const phones = importerPhones === undefined ? {} : { importerPhones };
  if (clockId === "GLOBAL#firm-delta") return { kind: "DEMO", template: "demo-firm-delta", ...phones };
  if (clockId === "GLOBAL#firm-norte") return { kind: "DEMO", template: "demo-firm-norte", ...phones };
  if (clockId === "GLOBAL#firm-qa") return { kind: "DEMO", template: "qa-min" };
  throw new ToolError("FORBIDDEN", `${clockId} is not rebuilt from a template`, "NOT_RESETTABLE");
}

/**
 * The factory's part of a reset (clock/reset.ts): the world written again at the new epoch, from its
 * template as it is in the bucket now. The clock already moved; a public guest world keeps its expiry.
 */
export async function reloadWorld(input: { readonly clockId: string; readonly firmId: string; readonly worldEpoch: number; readonly request?: WorldRequest }, deps: WorldsDeps): Promise<{ readonly startAtSim: string; readonly operations: readonly WrittenOperation[] }> {
  const request = input.request ?? rebuildRequest(input.clockId, input.firmId);
  if (request.kind !== "DEMO" && request.kind !== "GUEST") throw new ToolError("FORBIDDEN", "QA runs are destroyed, never reset", "NOT_RESETTABLE");
  const plan = planFromTemplate(await deps.templates.read(request.kind === "DEMO" ? request.template : "guest"), request);
  const written = await writeWorld(plan, input.worldEpoch, deps);
  return { startAtSim: plan.startAtSim, operations: written.operations };
}
