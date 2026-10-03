// What the panel asks the BFF (`tour` router, docs/tool-catalog.md): `tour.steps` answers operation
// 4471 of the user's world and every pending timer of it (the hours of "Qué mirar"), and `tour.run`
// runs one move of a step through the console's own procedures on the server (`clock.*`,
// `dossier.approve`, which asks for a recent sign-in: the panel shows the password prompt when the BFF
// says so). Opening a view is navigation and never reaches here.
import type { ConsoleClient } from "../../lib/trpc";
import type { RouterOutputs } from "../../lib/trpc-router";
import type { TourAction } from "./steps";

export type TourContext = RouterOutputs["tour"]["steps"];

/** Reason the BFF answers when the user's world has no operation 4471. */
export const TOUR_OPERATION_MISSING = "TOUR_OPERATION_MISSING";

export function fetchTourContext(trpc: ConsoleClient, signal?: AbortSignal): Promise<TourContext> {
  return trpc.tour.steps.query({}, signal ? { signal } : undefined);
}

/** Operation 4471 of the user's world (its id differs between worlds; its number does not). */
export async function findTourOperation(trpc: ConsoleClient): Promise<TourContext["operation"]> {
  return (await fetchTourContext(trpc)).operation;
}

export async function runTourAction(trpc: ConsoleClient, action: Exclude<TourAction, { kind: "open" }>): Promise<void> {
  await trpc.tour.run.mutate({ action });
}
