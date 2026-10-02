// `clock` router (docs/tool-catalog.md, docs/architecture.md §8 and §10): what the simulated-time bar
// of the console shows. `clock.get` answers the world's mode, simulated "now" and epoch, the next
// events (SCHEDULED timers of the world in `dueAtSim` order), whether the world is busy and with what
// (events in flight, mails in transit, PDFs waiting for their scan), and whether "Reiniciar demo" is
// open (once every 10 real minutes per world from the console).
//
// `worldOf` is how every feature router finds the world of a request: the clock the input names
// (already fenced to the principal's firm by `firmProcedure`) or, for a demo or guest firm, its own.
import { z } from "zod";
import { ClockId, type PendingKind, operationNumberOf } from "@legajo/shared";
import type { Connector } from "../connector/index";
import { effectiveMode, simNowOf } from "../lib/clock";
import { refusal } from "./errors";
import { type FirmContext, firmProcedure, router } from "./trpc";

/** The world a procedure reads: a clock of the firm, or the firm's own when left out. */
export const WorldFields = z.object({ clockId: ClockId.optional() }).strict();

/** Input of a procedure that reads one world; the console may send no input at all. */
export const WorldInput = WorldFields.prefault({});

/** The world of the request: the clock it names, else the firm's own clock. */
export async function worldOf(ctx: Pick<FirmContext, "deps" | "principal">, requested: string | undefined): Promise<string> {
  if (requested !== undefined) return requested;
  const firm = await ctx.deps.connector.firms.findFirm(ctx.principal.firmId);
  if (firm?.clockId === undefined) throw refusal("INVALID", "this firm has several worlds: name the one to show", "WORLD_REQUIRED");
  return firm.clockId;
}

/** "Reiniciar demo" from the console: at most once every 10 real minutes per world. */
export const CONSOLE_RESET_INTERVAL_MS = 10 * 60_000;

/** How many upcoming events the bar lists. */
export const NEXT_EVENTS_LIMIT = 5;

export interface PendingItem {
  readonly kind: PendingKind;
  readonly operationNumber?: string;
  /** Event id, what the mail waits for, or the bucket of the scan: never an address or a key. */
  readonly detail: string;
  /**
   * Real instant the wait started. An event in flight carries the last change of the world's
   * in-flight set (the set keeps no time per event), so its age never overstates the wait.
   */
  readonly sinceReal: string;
  /** Past its stale mark: reported, no longer waited for. */
  readonly stale: boolean;
}

/** What the world waits for (docs/architecture.md §7): in-flight events and open pending mails and scans. */
export async function pendingOf(data: Connector, clockId: string, realNow: Date): Promise<PendingItem[]> {
  const [world, pending] = await Promise.all([data.world.getWorldState(clockId), data.world.listPending(clockId)]);
  const now = realNow.getTime();
  const events = (world?.inFlight ?? []).map((entry): PendingItem => {
    const [operationId = "", eventId = entry] = entry.split("#");
    const operationNumber = operationId === "" ? undefined : safeNumber(operationId);
    return { kind: "EVENT", ...(operationNumber === undefined ? {} : { operationNumber }), detail: eventId, sinceReal: world?.updatedAt ?? realNow.toISOString(), stale: false };
  });
  const mails = pending.mails.map(
    (mail): PendingItem => ({
      kind: "MAIL",
      ...(mail.operationId === undefined ? {} : { operationNumber: operationNumberOf(mail.operationId) }),
      detail: mail.awaiting,
      sinceReal: mail.sentAtReal,
      stale: Date.parse(mail.staleAtReal) <= now,
    }),
  );
  const scans = pending.scans.map(
    (scan): PendingItem => ({
      kind: "SCAN",
      ...(scan.operationId === undefined ? {} : { operationNumber: operationNumberOf(scan.operationId) }),
      detail: scan.bucket,
      sinceReal: scan.createdAtReal,
      stale: Date.parse(scan.staleAtReal) <= now,
    }),
  );
  return [...events, ...mails, ...scans];
}

function safeNumber(operationId: string): string | undefined {
  try {
    return operationNumberOf(operationId);
  } catch {
    return undefined;
  }
}

/** When the console may reset the world again; `undefined` when it may now. */
export function nextResetAtReal(lastResetAtReal: string | undefined, realNow: Date): string | undefined {
  if (lastResetAtReal === undefined) return undefined;
  const next = Date.parse(lastResetAtReal) + CONSOLE_RESET_INTERVAL_MS;
  return next > realNow.getTime() ? new Date(next).toISOString() : undefined;
}

export const clockRouter = router({
  get: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
    const clockId = await worldOf(ctx, input.clockId);
    const data = ctx.deps.connector;
    const clock = await data.world.getClock(clockId);
    const realNow = ctx.deps.wallClock();
    const [timers, waits] = await Promise.all([data.timers.listScheduledTimers(clockId), pendingOf(data, clockId, realNow)]);
    // A stale pending is reported apart: the world no longer waits for it.
    const pending = waits.filter((item) => !item.stale);
    const nextReset = nextResetAtReal(clock.lastResetAtReal, realNow);
    return {
      clockId,
      mode: effectiveMode(clock, realNow.getTime()),
      simNow: simNowOf(clock, realNow.getTime()).toISOString(),
      startAtSim: clock.startAtSim,
      worldEpoch: clock.worldEpoch,
      runningUntilReal: clock.runningUntilReal ?? null,
      nextEvents: timers.slice(0, NEXT_EVENTS_LIMIT).map((timer) => ({
        operationId: timer.operationId,
        operationNumber: operationNumberOf(timer.operationId),
        kind: timer.kind,
        timerId: timer.timerId,
        dueAtSim: timer.dueAtSim,
        ...(timer.reason === undefined ? {} : { reason: timer.reason }),
      })),
      busy: pending.length > 0,
      pending,
      stale: waits.filter((item) => item.stale),
      reset: nextReset === undefined ? { allowed: true as const } : { allowed: false as const, nextAllowedAtReal: nextReset },
    };
  }),
});
