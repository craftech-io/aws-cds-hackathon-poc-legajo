// `Operations/TIMER#<kind>#<timerId>` (ADR-0004): a SCHEDULED timer carries `clockDueKey` and
// `dueAtSim` (canonical UTC), so it is in the sparse GSI3 of its world; leaving SCHEDULED removes
// `clockDueKey` in the same write. Every change bumps `version`, and a schedule that fires with an
// older version is ignored by the dispatcher (docs/architecture.md §8).
import { ConnectorError, TimerKind } from "@legajo/shared";
import { ZonedInstant, utcInstant } from "../../domain/common";
import { Timer, parseTimerKey } from "../../domain/timers";
import type { TableName } from "../../lib/resource";
import { expectedIndexAttributes } from "../item-shape";
import { TIMER_PREFIX, clockDueKey, operationPartition, timerKey, timerKindPrefix } from "../keys";
import type { TimersPort } from "../ports";
import type { Key } from "../table-client";
import { createRow, optionalEntity, parseEntities, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Operations";

function keyOf(operationId: string, key: string): Key {
  const parsed = parseTimerKey(key);
  if (!parsed) throw new ConnectorError("VALIDATION", `invalid timer key ${key}`, TABLE);
  return timerKey(operationId, parsed.kind, parsed.timerId);
}

export function timersRepo(ctx: RepoContext): TimersPort {
  const { client } = ctx;

  const getTimer = async (operationId: string, key: string): Promise<Timer> =>
    requireEntity(Timer, "Timer", await client.get(TABLE, keyOf(operationId, key)), TABLE, `timer ${key} of ${operationId}`);

  /** The SCHEDULED timer at the version the caller expects. */
  async function scheduled(operationId: string, key: string, expectedVersion: number | undefined): Promise<Timer> {
    const timer = await getTimer(operationId, key);
    if (expectedVersion !== undefined && expectedVersion !== timer.version) throw new ConnectorError("CONFLICT", `timer ${key} changed`, TABLE);
    if (timer.status !== "SCHEDULED") throw new ConnectorError("CONFLICT", `timer ${key} is already ${timer.status}`, TABLE);
    return timer;
  }

  const guard = (timer: Timer) => ({ condition: { ifVersion: timer.version, equals: { status: "SCHEDULED" } } });

  async function scheduledOf(clockId: string, range: { gte?: string; lt?: string; lte?: string }, limit?: number): Promise<Timer[]> {
    const { gte, lt, lte } = range;
    const spec =
      gte !== undefined && lt !== undefined
        ? { between: [utcInstant(gte), utcInstant(lt)] as const }
        : gte !== undefined
          ? { gte: utcInstant(gte) }
          : lte !== undefined
            ? { lte: utcInstant(lte) }
            : lt !== undefined
              ? { lt: utcInstant(lt) }
              : undefined;
    const rows = await client.query(TABLE, { index: "GSI3", hashValue: clockDueKey(clockId), ...(spec ? { range: spec } : {}), ...(limit === undefined ? {} : { limit }) });
    const timers = parseEntities(Timer, "Timer", rows, TABLE);
    // BETWEEN is inclusive; the horizon is half-open.
    return lt !== undefined ? timers.filter((timer) => Date.parse(timer.dueAtSim) < Date.parse(lt)) : timers;
  }

  return {
    getTimer,

    async createTimer(timer) {
      const dueAtSim = utcInstant(ZonedInstant.parse(timer.dueAtSim));
      const fields = { ...timer, dueAtSim };
      return createRow(ctx, TABLE, Timer, "Timer", timerKey(timer.operationId, timer.kind, timer.timerId), fields, { gsi: expectedIndexAttributes("Timer", fields) });
    },

    async findTimer(operationId, key) {
      return optionalEntity(Timer, "Timer", await client.get(TABLE, keyOf(operationId, key)), TABLE);
    },

    async listTimers(operationId, options = {}) {
      const prefix = options.kind === undefined ? TIMER_PREFIX : timerKindPrefix(TimerKind.parse(options.kind));
      const rows = await client.query(TABLE, { hashValue: operationPartition(operationId), range: { prefix }, ...(options.status ? { filter: { equals: { status: options.status } } } : {}) });
      return parseEntities(Timer, "Timer", rows, TABLE);
    },

    async listDueTimers(clockId, until, options = {}) {
      return scheduledOf(clockId, { lte: until }, options.limit);
    },

    async listScheduledTimers(clockId, options = {}) {
      return scheduledOf(clockId, { ...(options.from === undefined ? {} : { gte: options.from }), ...(options.until === undefined ? {} : { lt: options.until }) });
    },

    async nextScheduledTimer(clockId, after) {
      const timers = await scheduledOf(clockId, after === undefined ? {} : { gte: after }, 1);
      return timers[0];
    },

    async rescheduleTimer(input) {
      const timer = await scheduled(input.operationId, input.timerKey, input.expectedVersion);
      const dueAtSim = utcInstant(ZonedInstant.parse(input.dueAtSim));
      return updateRow(ctx, TABLE, Timer, "Timer", keyOf(input.operationId, input.timerKey), { set: { dueAtSim, reason: input.reason } }, guard(timer));
    },

    async completeTimer(completion) {
      const timer = await scheduled(completion.operationId, completion.timerKey, completion.expectedVersion);
      if (completion.status === "FIRED" && completion.firedBy === undefined) throw new ConnectorError("VALIDATION", "a fired timer says what fired it", TABLE);
      const set = {
        status: completion.status,
        firedBy: completion.firedBy,
        firedAtSim: completion.status === "FIRED" ? utcInstant(ZonedInstant.parse(completion.atSim)) : undefined,
        reason: completion.reason,
        clockDueKey: null,
        scheduleName: null,
      };
      return updateRow(ctx, TABLE, Timer, "Timer", keyOf(completion.operationId, completion.timerKey), { set }, guard(timer));
    },

    async setScheduleName(input) {
      const timer = await scheduled(input.operationId, input.timerKey, input.expectedVersion);
      return updateRow(ctx, TABLE, Timer, "Timer", keyOf(input.operationId, input.timerKey), { set: { scheduleName: input.scheduleName } }, { ...guard(timer), keepVersion: true });
    },
  };
}
