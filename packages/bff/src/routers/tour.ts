// `tour` router (docs/tool-catalog.md "Procedimientos de la consola"; docs/design-brief.md §15): the
// server side of the "Recorrido guiado". The steps themselves (titles, texts, expected hours) have one
// source, packages/web/src/views/tour/steps.ts; this router answers what the panel cannot know alone
// and runs each button through the console's own procedures, so a tour move passes exactly the gates
// of the same click elsewhere (firm, role, recent sign-in, `WORLD_BUSY`, guest quotas, audit):
//
//   steps   operation 4471 of the caller's world (its id differs between worlds, its number does not),
//           its ETA, and every pending timer of 4471 in `dueAtSim` order: the hours of "Qué mirar"
//           come from here, never from the text (clock.get lists only the world's next five events)
//   run     one move of a step: `advanceTo` and `advanceToNext` are `clock.*`; `moveEta` shifts the
//           current ETA of 4471 by whole days through `clock.moveEta`; `approve` is `dossier.approve`
//           (recent sign-in, ADR-0010); `emitDispatchStatus` is `clock.emitDispatchStatus`
import { z } from "zod";
import { PublishedDispatchStatus } from "@legajo/platform-mock/events";
import { CustomsChannel, IsoInstant } from "@legajo/shared";
import type { Operation } from "../domain/operations";
import { simNowOf } from "../lib/clock";
import { clockRouter } from "./clock";
import { dossierRouter } from "./dossier";
import { refusal } from "./errors";
import { type FirmContext, createCallerFactory, firmProcedure, router } from "./trpc";
import { WorldInput, worldOf } from "./world";

/** The operation the tour follows (docs/seed-spec.md §3, invariant 21). */
export const TOUR_OPERATION_NUMBER = "4471";

const DAY_MS = 24 * 60 * 60_000;

export const TourAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("advanceTo"), toSim: IsoInstant }).strict(),
  z.object({ kind: z.literal("advanceToNext") }).strict(),
  z.object({ kind: z.literal("moveEta"), shiftDays: z.number().int().min(-14).max(14).refine((days) => days !== 0, "a move of zero days changes nothing") }).strict(),
  z.object({ kind: z.literal("approve") }).strict(),
  z
    .object({ kind: z.literal("emitDispatchStatus"), status: PublishedDispatchStatus, channel: CustomsChannel.optional() })
    .strict()
    .refine((action) => (action.status === "CANAL_ASIGNADO") === (action.channel !== undefined), "a channel goes with CANAL_ASIGNADO and only with it"),
]);
export type TourAction = z.infer<typeof TourAction>;

export const TourRunInput = z.object({ action: TourAction }).strict();

/** `eta` moved by whole days, written in the offset it already has (`2026-10-20T08:00:00-03:00`). */
export function shiftDays(eta: string, days: number): string {
  const instant = Date.parse(eta) + days * DAY_MS;
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(eta);
  if (offset === null) return new Date(instant).toISOString();
  const [, sign, hours, minutes] = offset;
  const offsetMs = (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
  return `${new Date(instant + offsetMs).toISOString().slice(0, 19)}${offset[0]}`;
}

async function tourOperation(ctx: FirmContext, clockId: string): Promise<Operation | undefined> {
  const operations = await ctx.deps.connector.operations.listOperations(ctx.principal.firmId, { clockId });
  return operations.find((operation) => operation.operationNumber === TOUR_OPERATION_NUMBER);
}

async function requireTourOperation(ctx: FirmContext): Promise<Operation> {
  const operation = await tourOperation(ctx, await worldOf(ctx, undefined));
  if (operation === undefined) throw refusal("NOT_FOUND", `operation ${TOUR_OPERATION_NUMBER} is not in this world`, "TOUR_OPERATION_MISSING");
  return operation;
}

// The procedures a move runs, called in process with the request's own context: every middleware runs again.
const createMoveCaller = createCallerFactory(router({ clock: clockRouter, dossier: dossierRouter }));

function movesOf(ctx: FirmContext) {
  const { firmScope: _firmScope, ...context } = ctx;
  return createMoveCaller(context);
}

export const tourRouter = router({
  steps: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
    const clockId = await worldOf(ctx, input.clockId);
    const data = ctx.deps.connector;
    const [clock, operation] = await Promise.all([data.world.getClock(clockId), tourOperation(ctx, clockId)]);
    const timers = operation === undefined ? [] : (await data.timers.listScheduledTimers(clockId)).filter((timer) => timer.operationId === operation.operationId);
    return {
      clockId,
      worldEpoch: clock.worldEpoch,
      simNow: simNowOf(clock, ctx.deps.wallClock().getTime()).toISOString(),
      startAtSim: clock.startAtSim,
      operation: operation === undefined ? null : { operationId: operation.operationId, operationNumber: operation.operationNumber, eta: operation.eta },
      nextEvents: timers.map((timer) => ({ operationId: timer.operationId, operationNumber: TOUR_OPERATION_NUMBER, kind: timer.kind, dueAtSim: timer.dueAtSim })),
    };
  }),

  run: firmProcedure.input(TourRunInput).mutation(async ({ ctx, input }) => {
    const { action } = input;
    const moves = movesOf(ctx);
    switch (action.kind) {
      case "advanceTo":
        await moves.clock.advanceTo({ toSim: action.toSim });
        break;
      case "advanceToNext":
        await moves.clock.advanceToNext({});
        break;
      case "moveEta": {
        const operation = await requireTourOperation(ctx);
        await moves.clock.moveEta({ operationId: operation.operationId, eta: shiftDays(operation.eta, action.shiftDays) });
        break;
      }
      case "approve": {
        const operation = await requireTourOperation(ctx);
        await moves.dossier.approve({ operationId: operation.operationId });
        break;
      }
      case "emitDispatchStatus": {
        const operation = await requireTourOperation(ctx);
        await moves.clock.emitDispatchStatus({ operationId: operation.operationId, status: action.status, ...(action.channel === undefined ? {} : { channel: action.channel }) });
        break;
      }
    }
    return { kind: action.kind, done: true as const };
  }),
});
