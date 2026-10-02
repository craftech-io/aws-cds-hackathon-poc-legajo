// Windowed counters of `Runtime` (ADR-0015 §3.2 and §4): `RL#…` for the sign-up and the account
// emails, `QUOTA#…` for the guest worlds. One row per window bucket, `UpdateItem ADD` with a ceiling
// condition, so a counter never passes its limit even under concurrent calls; `expiresAt` is the end
// of the bucket plus an hour. A limit with several windows (5 an hour and 20 a day) moves all of them
// in one transaction or none, and a refusal says which window is full and when it resets.
import { ConnectorError } from "@legajo/shared";
import { COUNTER_GRACE_SECONDS, type LimitWindow, type WindowedLimit, windowBucket, windowEnd, windowMs } from "@legajo/shared/guest-limits";
import type { Key, TableClient } from "../connector/index";
import type { TransactOp } from "../connector/table-client";
import type { TableName } from "../lib/resource";

export const RUNTIME_TABLE: TableName = "Runtime";
const META = "META";
const ENTITY = "WindowCounter";

export type CounterOutcome = { readonly ok: true } | { readonly ok: false; readonly window: LimitWindow; readonly resetsAt: Date };

export interface CounterReading {
  readonly window: LimitWindow;
  readonly used: number;
  readonly limit: number;
  readonly resetsAt: Date;
}

/** `<base>#<bucket>` / `META`: one row per window bucket. */
export function counterKey(base: string, window: LimitWindow, at: Date): Key {
  return { PK: `${base}#${windowBucket(window, at)}`, SK: META };
}

function expiresAt(window: LimitWindow, at: Date): number {
  return Math.floor(windowEnd(window, at).getTime() / 1000) + COUNTER_GRACE_SECONDS;
}

function addOne(base: string, limit: WindowedLimit | undefined, window: LimitWindow, now: Date): Extract<TransactOp, { op: "update" }> {
  return {
    op: "update",
    table: RUNTIME_TABLE,
    key: counterKey(base, window, now),
    spec: { add: { count: 1 }, setIfAbsent: { entity: ENTITY, expiresAt: expiresAt(window, now) } },
    updatedAt: now.toISOString(),
    options: { upsert: true, ...(limit === undefined ? {} : { condition: { atMost: { attribute: "count", value: limit.limit - 1 } } }) },
  };
}

function countOf(item: Record<string, unknown> | undefined): number {
  return typeof item?.count === "number" ? item.count : 0;
}

/** Every window of `base` as it stands at `now`. */
export async function readWindowed(client: TableClient, base: string, limits: readonly WindowedLimit[], now: Date): Promise<CounterReading[]> {
  return Promise.all(
    limits.map(async (limit) => ({ window: limit.window, used: countOf(await client.get(RUNTIME_TABLE, counterKey(base, limit.window, now))), limit: limit.limit, resetsAt: windowEnd(limit.window, now) })),
  );
}

/** The full window that frees last: the instant the action is allowed again. */
export function fullestWindow(readings: readonly CounterReading[]): CounterOutcome {
  const full = readings.filter((reading) => reading.used >= reading.limit).sort((a, b) => b.resetsAt.getTime() - a.resetsAt.getTime());
  const [last] = full;
  return last === undefined ? { ok: true } : { ok: false, window: last.window, resetsAt: last.resetsAt };
}

async function refusalOf(client: TableClient, groups: readonly CounterGroup[], now: Date): Promise<CounterOutcome> {
  const readings = (await Promise.all(groups.map((group) => readWindowed(client, group.base, group.limits, now)))).flat();
  const outcome = fullestWindow(readings);
  // A race on the very last unit can leave every reading just under its limit: still a refusal.
  if (outcome.ok) {
    const [first] = groups.flatMap((group) => group.limits);
    return { ok: false, window: first?.window ?? "HOUR", resetsAt: windowEnd(first?.window ?? "HOUR", now) };
  }
  return outcome;
}

export interface CounterGroup {
  readonly base: string;
  readonly limits: readonly WindowedLimit[];
}

/**
 * Counts one unit in every window of every group, or in none when any window is full. `CONFLICT` of
 * the ceiling becomes a refusal; any other failure of the store propagates (fail closed upstream).
 * With `explain: false` a refusal names the first window without reading the counters back (for
 * callers that only need yes or no and may only write their counters, like `SignupDispatch`).
 */
export async function consumeWindowed(client: TableClient, groups: readonly CounterGroup[], now: Date, options: { readonly explain?: boolean } = {}): Promise<CounterOutcome> {
  const ops = groups.flatMap((group) => group.limits.map((limit) => addOne(group.base, limit, limit.window, now)));
  if (ops.length === 0) return { ok: true };
  try {
    const [only] = ops;
    if (ops.length === 1 && only !== undefined) await client.update(only.table, only.key, only.spec, only.updatedAt, only.options);
    else await client.transact(ops);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    if (options.explain !== false) return refusalOf(client, groups, now);
    const window = groups[0]?.limits[0]?.window ?? "HOUR";
    return { ok: false, window, resetsAt: windowEnd(window, now) };
  }
}

/** Counts one unit without a ceiling (what is only measured, like every account email sent). */
export async function countWindowed(client: TableClient, base: string, window: LimitWindow, now: Date): Promise<number> {
  const op = addOne(base, undefined, window, now);
  return countOf(await client.update(op.table, op.key, op.spec, op.updatedAt, op.options));
}

/** Deletes the buckets of `base` that may still hold a count at `now` (the current and the previous one). */
export async function forgetWindowed(client: TableClient, base: string, windows: readonly LimitWindow[], now: Date): Promise<void> {
  const keys = windows.flatMap((window) => [counterKey(base, window, now), counterKey(base, window, new Date(now.getTime() - windowMs(window)))]);
  await client.batchDelete(RUNTIME_TABLE, keys);
}
