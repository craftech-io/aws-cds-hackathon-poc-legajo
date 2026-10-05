// `destroy_world` (docs/architecture.md §8, ADR-0015 §4, docs/tool-catalog.md `world.destroy`): a guest
// world (TTL, `GUEST_DESTROY`) or a QA run, never a demo world (FORBIDDEN). In this order:
//
//   1 the world's broker rows (a guest's token is refused from here on: no row, 403 GUEST_WORLD_GONE)
//   2 the schedules of its SCHEDULED timers (`tm-g-*`, `tm-q-*`)
//   3 its S3 objects, before the rows that cite them: the guest prefix of every epoch of the firm in
//     Documents and Media (or `qa/<runId>/`), `uploads/<token>/` of the links its messages carried, and
//     the raw MIME of the mail bucket its messages cite, each only where the role's grant covers it
//     (the QaDriver's `QaWorldObjects` leaves uploads and MIME to the buckets' 1- and 30-day lifecycle)
//   4 every item of its clock (clock/world-items.ts), the firm's own rows (a guest firm), the `Platform`
//     partitions `POP#<firmId>#<number>` of its operations, and the upload links
//   5 the Memory of its actors: pass 1 here, the rest by `continuePurge` (docs/architecture.md §9.3)
//   6 the tombstone of its epoch, the clock row, and (QA) the number and phone leases it held
//
// `COUNTER#EPOCH#<clockId>` is never deleted: the next world of the same clock starts at a higher epoch.
// A QA run's deletes carry `QA_DELETE_CONDITION` (`world = qa` and a QA clock): an item of any other
// world is left where it is, whatever key reached it.
import { ConnectorError, GUEST_TEST_CLOCK_ID, QA_GLOBAL_CLOCK_ID, ToolError, parseClockId } from "@legajo/shared";
import { guestWorldPrefix } from "@legajo/shared/document-keys";
import { purgeWorldItems } from "../clock/world-items";
import { QA_DELETE_CONDITION } from "../connector/world-conditions";
import { clockKey, firmPartition, mailboxPartition, operationPartition, uploadLinkKey } from "../connector/keys";
import type { Item, Key, TableClient, WriteCondition } from "../connector/table-client";
import type { Operation } from "../domain/operations";
import { importerSessionId, runtimeSessionId } from "../lib/crypto";
import type { TableName } from "../lib/resource";
import { actorIdOf } from "../turns/identity";
import type { WorldsDeps } from "./deps";
import { addressHashOf } from "./instantiate";
import { purgeFirstPass, type PurgeTarget } from "./memory-purge";
import { isPublicGuestFirm } from "./guest-slots";
import type { WorldObjectBucket } from "./objects";

const SEEDED_HISTORY_MS = 31 * 24 * 60 * 60_000;
/** Sessions of an operation the purge names besides what Memory lists (`sessionEpoch` 0 to this). */
const NAMED_SESSION_EPOCHS = 3;
const UPLOAD_TOKEN = /\/u\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;

export interface DestroyedWorld {
  readonly clockId: string;
  readonly destroyed: boolean;
  readonly worldEpoch?: number;
  readonly objects: number;
}

/** Only guest worlds and QA runs are destroyed; the two fixed QA worlds are reset instead. */
export function isDestroyable(clockId: string): boolean {
  const scope = parseClockId(clockId)?.scope;
  if (clockId === QA_GLOBAL_CLOCK_ID) return false;
  return scope === "GUEST" || scope === "QA" || clockId === GUEST_TEST_CLOCK_ID;
}

/** A client whose bulk deletes are conditional deletes: an item that fails the condition stays. */
export function conditionalDeletes(client: TableClient, condition: WriteCondition): TableClient {
  async function batchDelete(table: TableName, keys: readonly Key[]): Promise<void> {
    for (const key of keys) {
      try {
        await client.delete(table, key, condition);
      } catch (error) {
        if (!(error instanceof ConnectorError && (error.code === "CONFLICT" || error.code === "NOT_FOUND"))) throw error;
      }
    }
  }
  // Every other method is the client's own, bound to it (an adapter may be a class instance).
  return new Proxy(client, { get: (target, property) => (property === "batchDelete" ? batchDelete : (Reflect.get(target, property, target) as unknown)) });
}

interface WorldFacts {
  readonly operations: readonly Operation[];
  readonly importerIds: readonly string[];
  readonly phones: readonly string[];
  readonly uploadTokens: readonly string[];
  readonly mailIds: readonly string[];
  readonly mailboxIds: readonly string[];
}

async function factsOf(clockId: string, firmId: string, client: TableClient, deps: WorldsDeps): Promise<WorldFacts> {
  const operations = await deps.data.operations.listOperations(firmId, { clockId });
  const importers = await deps.data.parties.listImporters(firmId, { clockId });
  const tokens = new Set<string>();
  const mailIds = new Set<string>();
  for (const operation of operations) {
    for (const row of await client.query("Conversations", { hashValue: operationPartition(operation.operationId) })) {
      for (const match of JSON.stringify(row.buttons ?? []).matchAll(UPLOAD_TOKEN)) if (match[1] !== undefined) tokens.add(match[1]);
      if (row.entity === "Message" && row.channel === "EMAIL" && row.direction === "IN" && typeof row.providerMessageId === "string") mailIds.add(row.providerMessageId);
    }
  }
  const mailboxIds = new Set<string>();
  const firm = await deps.data.firms.findFirm(firmId);
  const mailboxes = [...(firm === undefined ? [] : [firm.mailboxAddress])];
  for (const supplier of await deps.data.parties.listSuppliers(firmId, { clockId })) for (const contact of await deps.data.parties.listContacts(supplier.supplierId)) mailboxes.push(contact.email);
  for (const address of mailboxes) {
    for (const row of await client.query("Conversations", { hashValue: mailboxPartition(address), filter: { equals: { clockId } } })) if (typeof row.sesMessageId === "string") mailboxIds.add(row.sesMessageId);
  }
  return { operations, importerIds: importers.map((importer) => importer.importerId), phones: importers.map((importer) => importer.phoneE164), uploadTokens: [...tokens], mailIds: [...mailIds], mailboxIds: [...mailboxIds] };
}

async function deleteBrokers(firmId: string, client: TableClient): Promise<void> {
  const rows = await client.query("Firms", { hashValue: firmPartition(firmId), range: { prefix: "BROKER#" } });
  if (rows.length > 0) await client.batchDelete("Firms", rows.map((row) => ({ PK: row.PK, SK: row.SK })));
}

async function unschedule(facts: WorldFacts, deps: WorldsDeps): Promise<void> {
  for (const operation of facts.operations) {
    for (const timer of await deps.data.timers.listTimers(operation.operationId, { status: "SCHEDULED" })) if (timer.scheduleName !== undefined) await deps.scheduler.delete(timer.scheduleName);
  }
}

const SAFE_MAIL_ID = /^[A-Za-z0-9._-]{1,128}$/;

async function deleteObjects(clockId: string, firmId: string, facts: WorldFacts, deps: WorldsDeps, runId: string | undefined): Promise<number> {
  let deleted = 0;
  if (runId !== undefined) {
    for (const bucket of ["Documents", "Media", "Uploads"] as WorldObjectBucket[]) deleted += await deps.objects.deletePrefix(bucket, `qa/${runId}/`);
  } else if (parseClockId(clockId)?.scope === "GUEST") {
    // Every epoch of the firm (`…/<firmId>/e`): a reset that failed half-way may have left an older prefix behind.
    const prefix = guestWorldPrefix({ guestKind: isPublicGuestFirm(firmId) ? "PUBLIC" : "RESERVED", firmId, epoch: 1 }).replace(/1\/$/, "");
    for (const bucket of ["Documents", "Media"] as WorldObjectBucket[]) deleted += await deps.objects.deletePrefix(bucket, prefix);
  }
  // What the role may not delete (the QaDriver: `uploads/` and the mail bucket) is left to the bucket's lifecycle.
  for (const prefix of facts.uploadTokens.map((token) => `uploads/${token}/`)) if (deps.objects.covers("Uploads", prefix)) deleted += await deps.objects.deletePrefix("Uploads", prefix);
  const mime = [...facts.mailIds, ...facts.mailboxIds]
    .filter((id) => SAFE_MAIL_ID.test(id))
    .flatMap((id) => deps.mailPrefixes().map((prefix) => `${prefix}${id}`))
    .filter((key) => deps.objects.covers("InboundMail", key));
  if (mime.length > 0) deleted += await deps.objects.deleteKeys("InboundMail", mime);
  return deleted;
}

async function deletePlatform(firmId: string, facts: WorldFacts, client: TableClient): Promise<void> {
  for (const operation of facts.operations) {
    const rows = await client.query("Platform", { hashValue: `POP#${firmId}#${operation.operationNumber}` });
    if (rows.length > 0) await client.batchDelete("Platform", rows.map((row: Item) => ({ PK: row.PK, SK: row.SK })));
  }
}

/** The actors and Harness sessions of the world's epoch, for the Memory purge. */
export function purgeTargetOf(clockId: string, epoch: number, operations: ReadonlyArray<Pick<Operation, "operationId" | "importerId" | "sessionEpoch">>, importerIds: readonly string[], deps: Pick<WorldsDeps, "keys">): Omit<PurgeTarget, "startedAtReal"> {
  const actorIds = [...new Set(importerIds.map((importerId) => actorIdOf(importerId, epoch)))];
  const sessions = operations.flatMap((operation) =>
    Array.from({ length: Math.max(operation.sessionEpoch, NAMED_SESSION_EPOCHS) + 1 }, (_, sessionEpoch) => [
      { actorId: actorIdOf(operation.importerId, epoch), sessionId: runtimeSessionId(deps.keys.runtimeSession, { operationId: operation.operationId, clockId, worldEpoch: epoch, sessionEpoch }) },
      // The importer's conversation session (ADR-0017), under every session epoch an operation of it reached.
      { actorId: actorIdOf(operation.importerId, epoch), sessionId: importerSessionId(deps.keys.runtimeSession, { importerId: operation.importerId, clockId, worldEpoch: epoch, sessionEpoch }) },
    ]).flat(),
  );
  const unique = [...new Map(sessions.map((session) => [`${session.actorId}|${session.sessionId}`, session])).values()];
  return { clockId, epoch, actorIds, sessions: unique };
}

/** Destroys the world of `clockId` (see the header); a world without a clock answers `destroyed: false`. */
export async function destroyWorld(input: { readonly clockId: string; readonly reason: string }, deps: WorldsDeps): Promise<DestroyedWorld> {
  const { clockId } = input;
  if (!isDestroyable(clockId)) throw new ToolError("FORBIDDEN", `${clockId} is not a world that can be destroyed`, "NOT_DESTROYABLE");
  const clock = await deps.data.world.findClock(clockId);
  if (clock === undefined) return { clockId, destroyed: false, objects: 0 };
  const isQaRun = parseClockId(clockId)?.scope === "QA";
  const client = isQaRun || clockId === GUEST_TEST_CLOCK_ID ? conditionalDeletes(deps.client, QA_DELETE_CONDITION) : deps.client;
  const { firmId, worldEpoch } = clock;
  const facts = await factsOf(clockId, firmId, deps.client, deps);

  if (!isQaRun) await deleteBrokers(firmId, deps.client);
  await unschedule(facts, deps);
  const objects = await deleteObjects(clockId, firmId, facts, deps, isQaRun ? clock.runId : undefined);
  const now = deps.now();
  const start = Date.parse(clock.startAtSim);
  await purgeWorldItems(
    { clockId, firmId, fromSim: new Date(start - SEEDED_HISTORY_MS).toISOString(), toSim: new Date(Math.max(start, Date.parse(clock.pausedSimNow)) + SEEDED_HISTORY_MS).toISOString(), mailboxes: isQaRun ? [`estudio-${clockId}@sim.legajo.demo.craftech.io`] : [] },
    { client, data: deps.data, addressHash: (address) => addressHashOf(deps.keys, address) },
  );
  if (!isQaRun) {
    const firmRows = await deps.client.query("Firms", { hashValue: firmPartition(firmId) });
    if (firmRows.length > 0) await client.batchDelete("Firms", firmRows.map((row) => ({ PK: row.PK, SK: row.SK })));
  }
  await deletePlatform(firmId, facts, client);
  if (facts.uploadTokens.length > 0) await client.batchDelete("Runtime", facts.uploadTokens.map(uploadLinkKey));

  const { target } = await purgeFirstPass(deps, purgeTargetOf(clockId, worldEpoch, facts.operations, facts.importerIds, deps));
  await deps.continuePurge(target);

  await deps.data.world.putTombstone({ clockId, worldEpoch, atReal: now.toISOString() });
  await client.batchDelete("Runtime", [clockKey(clockId)]);
  if (isQaRun) {
    for (const operation of facts.operations) await deps.data.world.releaseLease({ kind: "OPNUM", value: operation.operationNumber, holder: clockId });
    for (const phone of facts.phones) await deps.data.world.releaseLease({ kind: "PHONE", value: phone, holder: clockId });
  }
  // No audit row: it would outlive the world in the firm's log and reach the slot's next owner.
  deps.log.info("worlds.destroyed", { clockId, worldEpoch, reason: input.reason, objects });
  return { clockId, destroyed: true, worldEpoch, objects };
}
