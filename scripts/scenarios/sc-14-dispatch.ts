// SC-14 · dispatch statuses (docs/test-plan.md §4.5): a clone of op-4487 (already approved, arrived on
// 16/10 07:00), Friday 16/10 09:30. Customs statuses come from the platform mock; each one is a fixed
// template, the orange channel gets its generic explanation, a late mail from the supplier on an
// approved file brings no reminder, a duplicate status sends nothing, and a status before approval
// (a clone of op-4471 in its own world) sends nothing either.
import { SENT_STATUSES, decisions, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { importerSays } from "./lib/flows";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { awaitState, createWorld, opOf, worldOf } from "./lib/world";

const START = "2026-10-16T09:30:00-03:00";

const dispatchNotices = (snapshot: Awaited<ReturnType<ScenarioContext["snapshot"]>>) => outbound(snapshot, { kind: "DISPATCH_STATUS", status: [...SENT_STATUSES] });

async function customs(ctx: ScenarioContext, status: "OFICIALIZADO" | "CANAL_ASIGNADO" | "LIBERADO", notices: number, channel?: "NARANJA") {
  const { operationId } = opOf(ctx);
  await ctx.qa("feed.customs", { operationId, status, ...(channel === undefined ? {} : { channel }) });
  if (status === "LIBERADO") ctx.state.liberadoKey = ctx.lastKey();
  return awaitState(ctx, operationId, `${notices} dispatch notice(s)`, (snapshot) => dispatchNotices(snapshot).length >= notices && snapshot.operation.dispatch.status === status);
}

export const sc14 = defineScenario({
  id: "SC-14",
  slug: "sc14",
  title: "Dispatch statuses",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "OFICIALIZADO reaches the importer as a template",
      flows: ["FL-077"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4487" }] });
        const snapshot = await customs(ctx, "OFICIALIZADO", 1);
        ctx.check(dispatchNotices(snapshot)[0]?.template?.name === "despacho_estado", "the notice is the template despacho_estado");
      },
    },
    {
      n: 2,
      title: "CANAL_ASIGNADO naranja",
      flows: ["FL-077"],
      async run(ctx) {
        await customs(ctx, "CANAL_ASIGNADO", 2, "NARANJA");
      },
    },
    {
      n: 3,
      title: "LIBERADO",
      flows: ["FL-077"],
      async run(ctx) {
        await customs(ctx, "LIBERADO", 3);
      },
    },
    {
      n: 4,
      title: "the release closes the operation: no timer left pending",
      flows: ["FL-077"],
      async run(ctx) {
        const settled = await ctx.settled(opOf(ctx).operationId);
        ctx.none(settled, "pending timers after LIBERADO", settled.pendingTimers);
      },
    },
    {
      n: 5,
      title: "“¿qué significa canal naranja?” is answered from the generic explanation",
      flows: ["FL-053"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const since = (await ctx.snapshot(operationId)).clock.simNow;
        await importerSays(ctx, operationId, "¿Qué significa que salió canal naranja?");
        await awaitState(ctx, operationId, "a REPLY", (snapshot) => outbound(snapshot, { kind: "REPLY", status: [...SENT_STATUSES], sinceSim: since }).length > 0);
      },
    },
    {
      n: 6,
      title: "a late mail of the supplier without a request brings no reminder or correction",
      flows: ["FL-058"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const since = (await ctx.snapshot(operationId)).clock.simNow;
        const { mailId } = (await ctx.qa("supplier.sendNow", { operationId, docTypes: ["COMMERCIAL_INVOICE"], version: 1 })) as { mailId: string };
        const outcome = (await ctx.qa("mail.outcome", { clockId: worldOf(ctx).clockId, mailId, timeoutSec: 300 })) as { outcome: string };
        ctx.check(outcome.outcome === "ENQUEUED", `the late mail was ${outcome.outcome}`);
        const settled = await ctx.settled(operationId);
        ctx.none(settled, "reminders or corrections after approval", outbound(settled, { kind: ["REMINDER", "CORRECTION_REQUEST"], sinceSim: since }));
      },
    },
    {
      n: 7,
      title: "the same LIBERADO event again sends nothing",
      flows: ["FL-078"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const platformKey = ctx.state.liberadoKey;
        ensure(typeof platformKey === "string", "step 3 kept the key of LIBERADO");
        await ctx.qa("feed.customs", { operationId, status: "LIBERADO", platformKey });
        await ctx.pause(WAITS.feedTransitSec);
        const settled = await ctx.settled(operationId);
        ctx.exactly(settled, 3, "dispatch notices (the duplicate sends nothing)", outbound(settled, { kind: "DISPATCH_STATUS" }));
      },
    },
    {
      n: 8,
      title: "a status before approval sends nothing",
      flows: ["FL-078"],
      async run(ctx) {
        await createWorld(ctx, { suffix: "open", startAtSim: START, operations: [{ key: "a", model: "op-4471" }] });
        const { operationId } = opOf(ctx, "a", "open");
        await ctx.settled(operationId);
        await ctx.qa("feed.customs", { operationId, status: "OFICIALIZADO" });
        await awaitState(ctx, operationId, "the early status recorded", (snapshot) => decisions(snapshot, { action: "DISPATCH_BEFORE_APPROVAL" }).length === 1);
        const settled = await ctx.settled(operationId);
        ctx.none(settled, "dispatch notices before approval", outbound(settled, { kind: "DISPATCH_STATUS" }));
      },
    },
  ],
});
