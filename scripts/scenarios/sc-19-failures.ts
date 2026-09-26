// SC-19 · failures (docs/test-plan.md §4.5): two clones of op-4471, Thursday 15/10 09:58. On `a` the
// reader fails for this world only (`FAULTS#<clockId>`): the version waits, is retried every 30
// simulated minutes and escalated after three failures, never read by us; when the reader is back a new
// version is read. On `b` the first turn is forced to fail and the importer gets the request anyway. A
// poison event reaches the DLQ, raises its alarm, and is deleted by the scenario (also in its cleanup).
import { WAITS } from "./lib/eventually";
import { SENT_STATUSES, openEscalations, outbound, timers } from "./lib/asserts";
import { expectTemplateRequest } from "./lib/flows";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { advanceTo, advanceToTimer, awaitState, createWorld, opOf, worldOf } from "./lib/world";

const START = "2026-10-15T09:58:00-03:00";
const B_DOCS_REQUEST = "2026-10-16T10:00:00-03:00";
const B_ETA = "2026-10-23T10:00:00-03:00";

async function sendPackingList(ctx: ScenarioContext, operationId: string, version: number): Promise<void> {
  await ctx.qa("wa.inbound", { operationId, message: { type: "document", docType: "PACKING_LIST", version } });
}

async function deleteOwnPoison(ctx: ScenarioContext): Promise<void> {
  const eventId = ctx.state.poisonEventId;
  if (typeof eventId === "string") await ctx.qa("dlq.delete", { clockId: worldOf(ctx).clockId, eventId });
}

export const sc19 = defineScenario({
  id: "SC-19",
  slug: "sc19",
  title: "Failures",
  suites: ["full"],
  cleanup: deleteOwnPoison,
  steps: [
    {
      n: 1,
      title: "the reader answers 503 for this world only",
      flows: ["FL-096"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4471" }, { key: "b", model: "op-4471", etaOverride: B_ETA }] });
        await ctx.qa("reader.setFaults", { clockId: worldOf(ctx).clockId, mode: "ERROR_503", rate: 1, minutes: 120 });
        await sendPackingList(ctx, opOf(ctx, "a").operationId, 2);
      },
    },
    {
      n: 2,
      title: "the version is kept as received and a reader retry is scheduled",
      flows: ["FL-096"],
      async run(ctx) {
        const waiting = await awaitState(ctx, opOf(ctx, "a").operationId, "READER_RETRY scheduled", (snapshot) => timers(snapshot, { kind: "READER_RETRY", status: "SCHEDULED" }).length === 1, WAITS.turnSec);
        ctx.check(waiting.versions.every((version) => version.reading === undefined), "no reading invented while the reader fails");
        ctx.check(waiting.documents.find((row) => row.docType === "PACKING_LIST")?.status === "RECEIVED", "the packing list is RECEIVED");
      },
    },
    {
      n: 3,
      title: "two more retries fail: the third failure escalates",
      flows: ["FL-096"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        for (let retry = 0; retry < 2; retry += 1) await advanceToTimer(ctx, operationId, "READER_RETRY");
        await awaitState(ctx, operationId, "READER_UNAVAILABLE escalation", (snapshot) => openEscalations(snapshot, "READER_UNAVAILABLE").length === 1);
      },
    },
    {
      n: 4,
      title: "the reader is back: a new version is read",
      flows: ["FL-096"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        await ctx.qa("reader.setFaults", { clockId: worldOf(ctx).clockId, mode: "NONE", rate: 0, minutes: 1 });
        await sendPackingList(ctx, operationId, 2);
        await awaitState(ctx, operationId, "a version read", (snapshot) => snapshot.versions.some((version) => version.reading !== undefined), WAITS.turnSec);
      },
    },
    {
      n: 5,
      title: "the first turn of b fails and the importer gets the request anyway",
      flows: ["FL-097"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "b");
        await ctx.qa("turn.forceFailure", { operationId });
        await advanceTo(ctx, operationId, B_DOCS_REQUEST);
        const fallback = await expectTemplateRequest(ctx, operationId);
        ctx.check(outbound(fallback, { kind: "DOCS_REQUEST", status: [...SENT_STATUSES] }).length === 1, "exactly one request reached the importer");
      },
    },
    {
      n: 6,
      title: "a poison event reaches the DLQ, raises the alarm and is deleted",
      flows: ["FL-098"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        const clockId = worldOf(ctx).clockId;
        const injectedAt = new Date().toISOString();
        const { eventId } = (await ctx.qa("event.poison", { operationId })) as { eventId: string };
        ctx.state.poisonEventId = eventId;
        ctx.note("poisonEventId", eventId);
        await awaitState(ctx, operationId, "processError of the poison event", (snapshot) => snapshot.processError?.eventId === eventId, WAITS.dlqSec);
        await ctx.qa("op.settle", { operationId, timeoutSec: WAITS.settleSec });
        const found = await ctx.eventually("the event in the DLQ", async () => {
          const match = (await ctx.qa("dlq.find", { clockId, eventId })) as { found: boolean; others: string[]; foreign: number };
          return match.found ? match : undefined;
        }, WAITS.dlqSec, 15);
        ctx.check(found.others.length === 0 && found.foreign === 0, `other events in the DLQ: ${[...found.others, ...(found.foreign > 0 ? [`${found.foreign} of other firms`] : [])].join(", ")}`);
        await ctx.eventually("the DLQ alarm in ALARM after the injection", async () => {
          const history = (await ctx.qa("alarm.history", { since: injectedAt })) as { transitions: Array<{ to?: string }> };
          return history.transitions.some((transition) => transition.to === "ALARM");
        }, WAITS.dlqSec, 30);
        const removed = (await ctx.qa("dlq.delete", { clockId, eventId })) as { deleted: boolean };
        ensure(removed.deleted, "the scenario's own event was deleted from the DLQ");
        delete ctx.state.poisonEventId;
        await ctx.eventually("the DLQ alarm back to OK", async () => {
          const history = (await ctx.qa("alarm.history", { since: injectedAt })) as { transitions: Array<{ to?: string }> };
          return history.transitions.at(-1)?.to === "OK";
        }, WAITS.dlqSec, 30);
      },
    },
  ],
});
