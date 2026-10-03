// The world a console request acts on and what the simulated-time bar shows of it (docs/architecture.md
// §8 and §10). `worldOf` is how every feature router finds the world of a request: the clock the input
// names (already fenced to the principal's firm by `firmProcedure`) or, for a demo or guest firm, its
// own. `clockSnapshot` is `clock.get` and the answer of every move: mode, simulated now and epoch, the
// next events (SCHEDULED timers in `dueAtSim` order), whether the world is busy and with what
// (clock/busy.ts `worldPending`), the stale waits apart, and whether "Reiniciar demo" is open.
import { z } from "zod";
import { ClockId, type PendingKind, operationNumberOf } from "@legajo/shared";
import { type WorldPending, worldPending } from "../clock/busy";
import { nextConsoleResetAtReal } from "../clock/reset";
import type { Connector } from "../connector/index";
import { effectiveMode, simNowOf } from "../lib/clock";
import { refusal } from "./errors";
import type { FirmContext } from "./trpc";

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

/** How many upcoming events the bar lists. */
export const NEXT_EVENTS_LIMIT = 5;

export interface PendingItem extends WorldPending {
  /** Past its stale mark: reported, no longer waited for. */
  readonly stale: boolean;
}

function numberOf(operationId: string | undefined): { readonly operationNumber?: string } {
  if (operationId === undefined) return {};
  try {
    return { operationNumber: operationNumberOf(operationId) };
  } catch {
    return {};
  }
}

/** Mails and scans past their stale mark: the console shows them apart, the world no longer waits. */
export async function staleOf(data: Connector, clockId: string, realNow: Date): Promise<PendingItem[]> {
  const now = realNow.getTime();
  const { mails, scans } = await data.world.listPending(clockId);
  const item = (kind: PendingKind, operationId: string | undefined, detail: string, sinceReal: string): PendingItem => ({ kind, ...numberOf(operationId), detail, sinceReal, stale: true });
  return [
    ...mails.filter((mail) => Date.parse(mail.staleAtReal) <= now).map((mail) => item("MAIL", mail.operationId, mail.awaiting, mail.sentAtReal)),
    ...scans.filter((scan) => Date.parse(scan.staleAtReal) <= now).map((scan) => item("SCAN", scan.operationId, scan.bucket, scan.createdAtReal)),
  ];
}

/** What the bar shows of a world right now (`clock.get`, and the answer of every move). */
export async function clockSnapshot(ctx: Pick<FirmContext, "deps">, clockId: string) {
  const data = ctx.deps.connector;
  const realNow = ctx.deps.wallClock();
  const clock = await data.world.getClock(clockId);
  const [timers, waits, stale] = await Promise.all([data.timers.listScheduledTimers(clockId), worldPending(data, clockId, realNow), staleOf(data, clockId, realNow)]);
  const pending: PendingItem[] = waits.map((wait) => ({ ...wait, stale: false }));
  const nextReset = nextConsoleResetAtReal(clock.lastResetAtReal, realNow);
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
    stale,
    reset: nextReset === undefined ? { allowed: true as const } : { allowed: false as const, nextAllowedAtReal: nextReset },
  };
}

export type ClockSnapshot = Awaited<ReturnType<typeof clockSnapshot>>;
