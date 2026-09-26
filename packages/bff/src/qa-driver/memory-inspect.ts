// `memory.inspect` (docs/tool-catalog.md, docs/architecture.md §9.3): the events of a Harness session
// and the long-term records of an actor in its three namespaces, each record with its key
// `{memoryRecordId, createdAt, contentSha256}` (the hash computed here over the record's text; never
// `updatedAt`). With `waitForExtraction` it polls every 15 s until the extraction of the last turn is
// complete, strategy by strategy:
//
//   preferences  a new or changed record (key not in `baseline`) matches the sentinel's keywords
//   facts        a new or changed record, or its keys unchanged for `stableSec` after the preference
//   summary      matched and at least `minQuietSec` after the turn ended (`afterTs`): a consolidating
//                strategy may update a record or do nothing instead of creating one
//   all          the keys of the three namespaces unchanged for `stableSec`
//
// Past `timeoutSec` it fails naming the strategy that is missing. Without this wait a negative assert
// on a strategy that has not extracted yet would pass empty.
import { ToolError } from "@legajo/shared";
import { sha256Hex } from "../lib/crypto";
import { QA_REASON } from "./contract";
import type { RecordKey, WaitForExtraction } from "./contract-inputs";
import { matchesKeywords } from "./keywords";

export const STRATEGIES = ["preferences", "facts", "summary"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type Completion = "MATCHED" | "NEW_OR_CHANGED" | "QUIET";

/** Polling period of the wait (docs/tool-catalog.md). */
export const EXTRACTION_POLL_MS = 15_000;

export interface StoredRecord {
  readonly memoryRecordId: string;
  readonly createdAt: string;
  readonly text: string;
}

/** Memory as the driver reads it (qa-driver/aws.ts over `@aws-sdk/client-bedrock-agentcore`). */
export interface MemoryReader {
  /** Text of every event of a session, in order. */
  listEvents(actorId: string, sessionId: string): Promise<Array<{ readonly eventId: string; readonly text: string }>>;
  /** Records of one namespace (or of every namespace under a prefix). */
  listRecords(namespace: string): Promise<StoredRecord[]>;
}

export interface InspectedRecord extends RecordKey {
  readonly strategy: Strategy;
  readonly namespace: string;
  readonly text: string;
}

export interface MemoryTarget {
  readonly actorId: string;
  /** Sessions whose events to list; the first one also names the summary namespace. */
  readonly sessionIds: readonly string[];
}

export function namespaceOf(strategy: Strategy, actorId: string, sessionId: string | undefined): string | undefined {
  if (strategy === "summary") return sessionId === undefined ? undefined : `/importers/${actorId}/${sessionId}/summary/`;
  return `/importers/${actorId}/${strategy}/`;
}

/** The strategy a namespace belongs to, for records listed under the actor's root. */
export function strategyOfNamespace(namespace: string): Strategy {
  if (namespace.endsWith("/summary/")) return "summary";
  return namespace.includes("/preferences/") ? "preferences" : "facts";
}

export function recordKeyString(key: RecordKey): string {
  return `${key.memoryRecordId}|${key.createdAt}|${key.contentSha256}`;
}

/** Every record of the actor's three namespaces (the summary of each session named). */
export async function listActorRecords(reader: MemoryReader, target: MemoryTarget): Promise<InspectedRecord[]> {
  const out: InspectedRecord[] = [];
  const namespaces: Array<[Strategy, string]> = [];
  for (const strategy of ["preferences", "facts"] as const) namespaces.push([strategy, namespaceOf(strategy, target.actorId, undefined) ?? ""]);
  for (const sessionId of target.sessionIds) namespaces.push(["summary", namespaceOf("summary", target.actorId, sessionId) ?? ""]);
  for (const [strategy, namespace] of namespaces) {
    for (const record of await reader.listRecords(namespace)) {
      out.push({ strategy, namespace, memoryRecordId: record.memoryRecordId, createdAt: record.createdAt, contentSha256: sha256Hex(record.text), text: record.text });
    }
  }
  return out;
}

export interface Inspection {
  readonly actorId: string;
  readonly sessionIds: readonly string[];
  readonly events: ReadonlyArray<{ readonly sessionId: string; readonly eventId: string; readonly text: string }>;
  readonly records: readonly InspectedRecord[];
  readonly completion?: Readonly<Record<Strategy, Completion>>;
  readonly waitedSec?: number;
}

export async function inspectMemory(reader: MemoryReader, target: MemoryTarget): Promise<Inspection> {
  const events = [];
  for (const sessionId of target.sessionIds) {
    for (const event of await reader.listEvents(target.actorId, sessionId)) events.push({ sessionId, ...event });
  }
  return { actorId: target.actorId, sessionIds: target.sessionIds, events, records: await listActorRecords(reader, target) };
}

export interface WaitDeps {
  readonly reader: MemoryReader;
  /** Real time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

interface Track {
  keys: string;
  changedAt: number;
  completion?: Completion;
}

function keysOf(records: readonly InspectedRecord[]): string {
  return records.map(recordKeyString).sort().join(",");
}

function missingOf(tracks: Readonly<Record<Strategy, Track>>, stable: boolean): string {
  if (tracks.preferences.completion === undefined) return "preferences (the sentinel did not appear in a new or changed preference)";
  const open = (["facts", "summary"] as const).filter((strategy) => tracks[strategy].completion === undefined);
  return open.length > 0 ? open.join(" and ") : stable ? "nothing" : "stability (records still changing)";
}

/** Polls until the extraction of the turn is complete by strategy, or fails naming what is missing. */
export async function waitForExtraction(deps: WaitDeps, target: MemoryTarget, wait: WaitForExtraction): Promise<Inspection> {
  const started = deps.now().getTime();
  const deadline = started + wait.timeoutSec * 1_000;
  const turnEnded = Date.parse(wait.afterTs);
  const baseline = new Set(wait.baseline.map(recordKeyString));
  const tracks = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, { keys: "", changedAt: started }])) as Record<Strategy, Track>;
  let allKeys: string | undefined;
  let allChangedAt = started;
  let matchedAt: number | undefined;
  for (let first = true; ; first = false) {
    const records = await listActorRecords(deps.reader, target);
    const at = deps.now().getTime();
    const everything = keysOf(records);
    if (everything !== allKeys) {
      if (!first) allChangedAt = at;
      allKeys = everything;
    }
    for (const strategy of STRATEGIES) {
      const own = records.filter((record) => record.strategy === strategy);
      const track = tracks[strategy];
      const keys = keysOf(own);
      if (!first && keys !== track.keys) track.changedAt = at;
      track.keys = keys;
      const fresh = own.filter((record) => !baseline.has(recordKeyString(record)));
      if (strategy === "preferences") {
        if (track.completion === undefined && fresh.some((record) => matchesKeywords(record.text, wait.sentinel.keywords))) {
          track.completion = "MATCHED";
          matchedAt = at;
        }
      } else if (track.completion === undefined || track.completion === "QUIET") {
        if (fresh.length > 0) track.completion = "NEW_OR_CHANGED";
        else if (matchedAt !== undefined && at - Math.max(track.changedAt, matchedAt) >= wait.stableSec * 1_000 && at - turnEnded >= wait.minQuietSec * 1_000) track.completion = "QUIET";
      }
    }
    const stable = at - allChangedAt >= wait.stableSec * 1_000;
    if (stable && STRATEGIES.every((strategy) => tracks[strategy].completion !== undefined)) {
      const inspection = await inspectMemory(deps.reader, target);
      const completion = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, tracks[strategy].completion])) as Record<Strategy, Completion>;
      return { ...inspection, completion, waitedSec: Math.round((at - started) / 1_000) };
    }
    if (at >= deadline) throw new ToolError("UNAVAILABLE", `memory extraction incomplete after ${wait.timeoutSec} s: ${missingOf(tracks, stable)}`, QA_REASON.EXTRACTION_INCOMPLETE);
    await deps.sleep(Math.min(EXTRACTION_POLL_MS, Math.max(1, deadline - at)));
  }
}
