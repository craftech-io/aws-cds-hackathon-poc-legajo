// Edge of the clock view with the BFF (docs/tool-catalog.md, `clock` router; docs/architecture.md §8).
// `clock.get` is polled by the shell (context/WorldClockContext.tsx); this view reads the rest of the
// same answer (next events, epoch, reset window) through `ClockDetail`. The commands below are typed
// procedures of the `AppRouter`, each input validated before it leaves and each answer read back with
// zod: the four that move time or inject events answer `WORLD_BUSY` with the world busy and accept
// `force` once the oldest pending is five minutes old; `setRunning` and `reset` do not take `force`.
//
//   clock.advanceTo           { toSim, force? }
//   clock.setRunning          { running }
//   clock.fireMilestone       { operationId, milestone, force? }
//   clock.moveEta             { operationId, eta, force? }
//   clock.emitDispatchStatus  { operationId, status, channel?, force? }
//   clock.reset               {}                (BROKER or GUEST, once every 10 minutes per world; the
//                                                shared `ClockResetInput`, as the scenarios send it)
import { ClockResetInput, CustomsChannel, IsoInstant, MilestoneName, OperationId, OperationNumber, TimerKind } from "@legajo/shared";
import { z } from "zod";
import type { ConsoleClient } from "../../lib/trpc";
import type { RouterInputs } from "../../lib/trpc-router";
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

type ClockInputs = RouterInputs["clock"];

/** The procedure of a command with its input, typed against the `AppRouter`. */
export type ClockRequest =
  | { readonly path: "clock.advanceTo"; readonly input: ClockInputs["advanceTo"] }
  | { readonly path: "clock.setRunning"; readonly input: ClockInputs["setRunning"] }
  | { readonly path: "clock.fireMilestone"; readonly input: ClockInputs["fireMilestone"] }
  | { readonly path: "clock.moveEta"; readonly input: ClockInputs["moveEta"] }
  | { readonly path: "clock.emitDispatchStatus"; readonly input: ClockInputs["emitDispatchStatus"] }
  | { readonly path: "clock.reset"; readonly input: ClockInputs["reset"] };

/** Procedure and input of a command; `force` only travels on the gated ones. A malformed one throws before it is sent. */
export function commandRequest(command: ClockCommand, force = false): ClockRequest {
  const forced = force && GATED_COMMANDS.has(command.kind) ? { force: true } : {};
  switch (command.kind) {
    case "advanceTo":
      return { path: "clock.advanceTo", input: { toSim: IsoInstant.parse(command.toSim), ...forced } };
    case "setRunning":
      return { path: "clock.setRunning", input: { running: command.running } };
    case "fireMilestone":
      return { path: "clock.fireMilestone", input: { operationId: OperationId.parse(command.operationId), milestone: MilestoneName.parse(command.milestone), ...forced } };
    case "moveEta":
      return { path: "clock.moveEta", input: { operationId: OperationId.parse(command.operationId), eta: IsoInstant.parse(command.eta), ...forced } };
    case "emitDispatchStatus": {
      const channel = command.channel === undefined ? {} : { channel: CustomsChannel.parse(command.channel) };
      return { path: "clock.emitDispatchStatus", input: { operationId: OperationId.parse(command.operationId), status: EmittedStatus.parse(command.status), ...channel, ...forced } };
    }
    case "reset":
      return { path: "clock.reset", input: ClockResetInput.parse({}) };
  }
}

function send(trpc: ConsoleClient, request: ClockRequest): Promise<unknown> {
  switch (request.path) {
    case "clock.advanceTo":
      return trpc.clock.advanceTo.mutate(request.input);
    case "clock.setRunning":
      return trpc.clock.setRunning.mutate(request.input);
    case "clock.fireMilestone":
      return trpc.clock.fireMilestone.mutate(request.input);
    case "clock.moveEta":
      return trpc.clock.moveEta.mutate(request.input);
    case "clock.emitDispatchStatus":
      return trpc.clock.emitDispatchStatus.mutate(request.input);
    case "clock.reset":
      return trpc.clock.reset.mutate(request.input);
  }
}

/** Runs a command; the answer carries the new snapshot (the shell polls again either way). */
export async function runClockCommand(trpc: ConsoleClient, command: ClockCommand, force = false): Promise<ClockDetail | undefined> {
  return clockDetailOf(await send(trpc, commandRequest(command, force)));
}
