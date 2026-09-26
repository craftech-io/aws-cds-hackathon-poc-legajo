// SC-10 · the ETA moves (docs/test-plan.md §4.5): op-4471 (ETA 22/10 08:00), Thursday 15/10 09:58. The
// carrier's events come from the platform mock through the `Feeds` bus; milestones are recalculated,
// the ones left in the past fire once, and a duplicate event or a schedule with a stale version never
// fires anything twice.
import type { QaSnapshot } from "@legajo/bff/qa-driver/snapshot";
import { SENT_STATUSES, decisions, milestone, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { defineScenario, ensure } from "./lib/steps";
import { awaitState, createWorld, opOf } from "./lib/world";

const START = "2026-10-15T09:58:00-03:00";
/** From the model's 22/10 08:00: two days forward, four days back, and five days forward of the original. */
const ETA = { minus2: "2026-10-20T08:00:00-03:00", plus4: "2026-10-26T08:00:00-03:00", minus5: "2026-10-17T08:00:00-03:00" };
const OVERDUE_AFTER_MINUS5 = ["DOCS_REQUEST", "FOLLOWUP", "FOLLOWUP_FINAL", "ESCALATION"];

/** ETA − 7 d 10:00, − 5 d 10:00, − 3 d 10:00, − 48 h and the ETA itself (docs/architecture.md §8). */
function milestonesFor(eta: string): Record<string, number> {
  const at = Date.parse(eta);
  const day = 24 * 3_600_000;
  const tenAm = (days: number) => {
    const date = new Date(at - days * day);
    return Date.parse(`${new Date(date.getTime() - 3 * 3_600_000).toISOString().slice(0, 10)}T10:00:00-03:00`);
  };
  return { DOCS_REQUEST: tenAm(7), FOLLOWUP: tenAm(5), FOLLOWUP_FINAL: tenAm(3), ESCALATION: at - 2 * day, ARRIVAL: at };
}

const firedTimes = (snapshot: QaSnapshot, name: string) =>
  snapshot.decisions.filter((row) => row.action === "MILESTONE_FIRED" && row.refs.timerKey === `TIMER#MILESTONE#${name}`).length;

export const sc10 = defineScenario({
  id: "SC-10",
  slug: "sc10",
  title: "ETA changes",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the carrier brings the ETA two days forward",
      flows: ["FL-061"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4471" }] });
        const { operationId } = opOf(ctx);
        await ctx.settled(operationId);
        await ctx.qa("feed.eta", { operationId, newEta: ETA.minus2 });
        await awaitState(ctx, operationId, "the new ETA stored", (snapshot) => Date.parse(snapshot.operation.eta) === Date.parse(ETA.minus2));
      },
    },
    {
      n: 2,
      title: "the pending milestones are recalculated from the new ETA",
      flows: ["FL-061"],
      async run(ctx) {
        const snapshot = await ctx.settled(opOf(ctx).operationId);
        const expected = milestonesFor(ETA.minus2);
        for (const name of ["FOLLOWUP_FINAL", "ESCALATION", "ARRIVAL"]) ctx.check(Date.parse(milestone(snapshot, name)?.dueAtSim ?? "") === expected[name], `${name} due at the new ETA's time`);
        ctx.check(snapshot.operation.etaHistory.length >= 2 && decisions(snapshot, { action: "ETA_RESCHEDULED" }).length === 1, "one ETA_RESCHEDULED with its history");
      },
    },
    {
      n: 3,
      title: "the importer is told the new deadline",
      flows: ["FL-061"],
      async run(ctx) {
        await awaitState(ctx, opOf(ctx).operationId, "ETA_CHANGE notice", (snapshot) => outbound(snapshot, { kind: "ETA_CHANGE", status: [...SENT_STATUSES] }).length > 0);
      },
    },
    {
      n: 4,
      title: "the ETA moves four days back: every pending milestone later, none fired again",
      flows: ["FL-062"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await ctx.settled(operationId);
        await ctx.qa("feed.eta", { operationId, newEta: ETA.plus4 });
        const moved = await awaitState(ctx, operationId, "ETA + 4 days stored", (snapshot) => Date.parse(snapshot.operation.eta) === Date.parse(ETA.plus4));
        const expected = milestonesFor(ETA.plus4);
        for (const name of ["FOLLOWUP_FINAL", "ESCALATION", "ARRIVAL"]) ctx.check(Date.parse(milestone(moved, name)?.dueAtSim ?? "") === expected[name], `${name} moved later`);
      },
    },
    {
      n: 5,
      title: "the importer is told again",
      flows: ["FL-062"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await awaitState(ctx, operationId, "a second ETA_CHANGE notice", (snapshot) => outbound(snapshot, { kind: "ETA_CHANGE", status: [...SENT_STATUSES] }).length >= 2);
        const settled = await ctx.settled(operationId);
        for (const name of ["DOCS_REQUEST", "FOLLOWUP"]) ctx.check(firedTimes(settled, name) <= 1, `${name} never fired twice`);
      },
    },
    {
      n: 6,
      title: "ETA five days forward leaves milestones in the past: each fires once",
      flows: ["FL-063"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const before = await ctx.settled(operationId);
        ctx.state.staleVersion = milestone(before, "FOLLOWUP")?.version;
        await ctx.qa("feed.eta", { operationId, newEta: ETA.minus5 });
        ctx.state.etaKey = ctx.lastKey();
        await awaitState(ctx, operationId, "ETA − 5 days stored", (snapshot) => Date.parse(snapshot.operation.eta) === Date.parse(ETA.minus5));
        const settled = await ctx.settled(operationId);
        for (const name of OVERDUE_AFTER_MINUS5) ctx.check(firedTimes(settled, name) === 1 && milestone(settled, name)?.status !== "SCHEDULED", `${name} fired exactly once`);
        ctx.check(outbound(settled, { kind: ["REMINDER", "DOCS_REQUEST"], counterpart: "IMPORTER" }).length <= 2, "at most one reminder per contact");
      },
    },
    {
      n: 7,
      title: "the same event again and a schedule with a stale version fire nothing",
      flows: ["FL-064"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const platformKey = ctx.state.etaKey;
        const staleVersion = ctx.state.staleVersion;
        ensure(typeof platformKey === "string" && typeof staleVersion === "number", "step 6 kept its event key and the milestone's version");
        const replay = (await ctx.qa("feed.eta", { operationId, newEta: ETA.minus5, platformKey })) as { replayed: boolean };
        ctx.check(replay.replayed, "the platform published the same event again");
        await ctx.qa("schedule.fireStale", { operationId, timerKey: "TIMER#MILESTONE#FOLLOWUP", version: staleVersion });
        await ctx.pause(WAITS.feedTransitSec);
        const settled = await ctx.settled(operationId);
        ctx.exactly(settled, 3, "ETA_RESCHEDULED decisions (one per real change)", decisions(settled, { action: "ETA_RESCHEDULED" }));
        ctx.exactly(settled, 1, "firings of FOLLOWUP", settled.decisions.filter((row) => row.action === "MILESTONE_FIRED" && row.refs.timerKey === "TIMER#MILESTONE#FOLLOWUP"));
      },
    },
  ],
});
