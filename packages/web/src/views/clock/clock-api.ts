// Edge of the clock view with the BFF (docs/tool-catalog.md, `clock` router; docs/architecture.md §8).
// `clock.get` is polled by the shell (context/WorldClockContext.tsx); this view reads the rest of the
// same answer (next events, epoch, reset window) through `ClockDetail`. The commands below go through
// tRPC's untyped client and are validated with zod, like the shell's moves (lib/console-api.ts): the
// six that move time or inject events answer `WORLD_BUSY` with the world busy and accept `force` once
// the oldest pending is five minutes old; `setRunning` and `reset` do not take `force`.
//
//   clock.advanceTo           { toSim, force? }
//   clock.setRunning          { running }
//   clock.fireMilestone       { operationId, milestone, force? }
//   clock.moveEta             { operationId, eta, force? }
//   clock.emitDispatchStatus  { operationId, status, channel?, force? }
//   clock.reset               {}                (BROKER or GUEST, once every 10 minutes per world; the
//                                                shared `ClockResetInput`, as the scenarios send it)
import { ClockResetInput, CustomsChannel, IsoInstant, MilestoneName, OperationNumber, TimerKind } from "@legajo/shared";
import { getUntypedClient } from "@trpc/client";
import { z } from "zod";
import type { ConsoleClient } from "../../lib/trpc";
import { ClockSnapshot } from "../../lib/world-clock";

/** One upcoming timer of the world (`clock.get.nextEvents`). */
export const NextEvent = z.looseObject({
  operationId: z.string().min(1),
  operationNumber: OperationNumber,
  kind: TimerKind,
  timerId: z.string().min(1),
  dueAtSim: IsoInstant,
  reason: z.string().nullish(),
});
export type NextEvent = z.infer<typeof NextEvent>;

export const ResetWindow = z.looseObject({ allowed: z.boolean(), nextAllowedAtReal: IsoInstant.nullish() });
export type ResetWindow = z.infer<typeof ResetWindow>;

/** `clock.get` as the clock view and the guided tour read it. */
export const ClockDetail = ClockSnapshot.extend({
  startAtSim: IsoInstant.nullish(),
  worldEpoch: z.number().int().positive().nullish(),
  nextEvents: z.array(NextEvent).default([]),
  reset: ResetWindow.nullish(),
});
export type ClockDetail = z.infer<typeof ClockDetail>;

/** The detail of the snapshot the shell already holds; undefined until it has one. */
export function clockDetailOf(snapshot: unknown): ClockDetail | undefined {
  if (snapshot === undefined) return undefined;
  const parsed = ClockDetail.safeParse(snapshot);
  return parsed.success ? parsed.data : undefined;
}

/** Statuses the platform publishes after approval (docs/architecture-integrations.md §6). */
export const EmittedStatus = z.enum(["OFICIALIZADO", "CANAL_ASIGNADO", "LIBERADO"]);
export type EmittedStatus = z.infer<typeof EmittedStatus>;

export type ClockCommand =
  | { readonly kind: "advanceTo"; readonly toSim: string }
  | { readonly kind: "setRunning"; readonly running: boolean }
  | { readonly kind: "fireMilestone"; readonly operationId: string; readonly milestone: MilestoneName }
  | { readonly kind: "moveEta"; readonly operationId: string; readonly eta: string }
  | { readonly kind: "emitDispatchStatus"; readonly operationId: string; readonly status: EmittedStatus; readonly channel?: CustomsChannel }
  | { readonly kind: "reset" };

/** Commands the BFF refuses with `WORLD_BUSY` while the world is busy (and that may be forced). */
export const GATED_COMMANDS: ReadonlySet<ClockCommand["kind"]> = new Set(["advanceTo", "fireMilestone", "moveEta", "emitDispatchStatus"]);

export interface ProcedureRequest {
  readonly path: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Procedure and input of a command; `force` only travels on the gated ones. */
export function commandRequest(command: ClockCommand, force = false): ProcedureRequest {
  const forced = force && GATED_COMMANDS.has(command.kind) ? { force: true } : {};
  switch (command.kind) {
    case "advanceTo":
      return { path: "clock.advanceTo", input: { toSim: IsoInstant.parse(command.toSim), ...forced } };
    case "setRunning":
      return { path: "clock.setRunning", input: { running: command.running } };
    case "fireMilestone":
      return { path: "clock.fireMilestone", input: { operationId: command.operationId, milestone: MilestoneName.parse(command.milestone), ...forced } };
    case "moveEta":
      return { path: "clock.moveEta", input: { operationId: command.operationId, eta: IsoInstant.parse(command.eta), ...forced } };
    case "emitDispatchStatus": {
      const channel = command.channel === undefined ? {} : { channel: CustomsChannel.parse(command.channel) };
      return { path: "clock.emitDispatchStatus", input: { operationId: command.operationId, status: EmittedStatus.parse(command.status), ...channel, ...forced } };
    }
    case "reset":
      return { path: "clock.reset", input: ClockResetInput.parse({}) };
  }
}

/** Runs a command; the answer may carry the new snapshot (the shell polls again either way). */
export async function runClockCommand(trpc: ConsoleClient, command: ClockCommand, force = false): Promise<ClockDetail | undefined> {
  const { path, input } = commandRequest(command, force);
  const raw = await getUntypedClient(trpc).mutation(path, input);
  return clockDetailOf(raw);
}
