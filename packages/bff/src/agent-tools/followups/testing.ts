// Fixtures of the `followups` and `handoff` tool tests: the tool wrapper's world (common/testing.ts) with
// the demo firm and its settings, a recording Scheduler and queue, and the target built over them.
import { seedFirm } from "../operations/testing";
import { type ToolWorld, toolWorld } from "../common/testing";
import { seedSettings, fakeScheduler, type FakeScheduler } from "../../milestones/testing";
import type { SimReplyHandoff } from "../../timers/events";
import { timerDispatcher } from "../../timers/timers";
import type { OperationQueueEventInput } from "../../worker/events";
import type { GatewayTargetRuntime } from "../common/handler";
import { createFollowupsTarget } from "./index";
import { followupsImplementations } from "./handler";

export interface FollowupsWorld extends ToolWorld {
  readonly scheduler: FakeScheduler;
  readonly enqueued: OperationQueueEventInput[];
  readonly handoffs: SimReplyHandoff[];
  readonly target: GatewayTargetRuntime;
}

export async function followupsWorld(): Promise<FollowupsWorld> {
  const world = await toolWorld();
  await seedFirm(world.stores);
  await seedSettings(world.stores);
  const scheduler = fakeScheduler();
  const enqueued: OperationQueueEventInput[] = [];
  const handoffs: SimReplyHandoff[] = [];
  const dispatcher = timerDispatcher({ events: { enqueue: async (event) => void enqueued.push(event) }, simReply: async (handoff) => void handoffs.push(handoff) });
  const target = createFollowupsTarget(world.deps, followupsImplementations({ scheduler, dispatcher }));
  return { ...world, scheduler, enqueued, handoffs, target };
}
