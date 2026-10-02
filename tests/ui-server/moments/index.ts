// The deterministic moments of the guest's world (docs/landing-spec.md §7.2.1), for the console captures
// of the landing on the local UI server: `start` is the `guest` template as the world factory creates
// it (clock paused on 14/10 10:30), and every later moment applies the steps of the story of 4471 up to
// it (story.ts) and pauses the clock at its time. Building a moment twice gives the same rows.
import type { MemoryStores } from "@legajo/bff/connector/index";
import { type GuestTables, captureTemplate, instantiateGuestWorld, loadGuestWorld } from "./guest-world";
import type { Tables } from "./rows";
import { resetIds } from "./rows";
import { MOMENT_IDS, type MomentId } from "./ids";
import { STORY_STEPS, resetStory } from "./story";

export { CAPTURE_GUEST } from "./guest-world";
export { MOMENT_IDS, type MomentId } from "./ids";

export interface MomentWorld {
  readonly id: MomentId;
  readonly simNow: string;
  readonly tables: GuestTables;
}

/** The rows of the guest's world at `id`, completed and keyed, and the time its clock shows. */
export async function momentWorld(id: MomentId): Promise<MomentWorld> {
  const template = captureTemplate();
  const draft = Object.fromEntries(Object.entries(template.items).map(([table, items]) => [table, items.map((item) => structuredClone(item))])) as Tables;
  resetIds();
  resetStory();
  const steps = STORY_STEPS.slice(0, MOMENT_IDS.indexOf(id) + 1);
  for (const step of steps) step.apply(draft);
  const last = steps[steps.length - 1];
  if (!last) throw new Error(`unknown moment ${id}`);
  return { id, simNow: last.simNow, tables: await instantiateGuestWorld({ ...template, items: draft }) };
}

/** Loads the moment's world into the stores of a local UI server. */
export async function loadMoment(stores: MemoryStores, id: MomentId): Promise<MomentWorld> {
  const world = await momentWorld(id);
  await loadGuestWorld(stores, world.tables, world.simNow);
  return world;
}
