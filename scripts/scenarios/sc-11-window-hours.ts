// SC-11 · the 24-hour window and Argentine business hours (docs/test-plan.md §4.5): clones of op-4472
// that only write to the importer (no supplier, so no authorization). Wednesday 14/10 with the request
// at 10:00; a second clone whose request falls on Monday 12/10, a holiday in Argentina, goes out on
// Tuesday 13/10 09:00.
import { SENT_STATUSES, outbound } from "./lib/asserts";
import { deferredThenSent, firstRequest, importerSays } from "./lib/flows";
import { defineScenario } from "./lib/steps";
import { advanceBy, advanceTo, awaitState, createWorld, opOf } from "./lib/world";

const MAIN = { start: "2026-10-14T09:58:00-03:00", eta: "2026-10-21T10:00:00-03:00", docsRequest: "2026-10-14T10:00:00-03:00", evening: "2026-10-15T20:00:00-03:00", nextMorning: "2026-10-16T09:00:00-03:00" };
const HOLIDAY = { start: "2026-10-12T09:58:00-03:00", eta: "2026-10-19T10:00:00-03:00", docsRequest: "2026-10-12T10:00:00-03:00", tuesday: "2026-10-13T09:00:00-03:00" };

export const sc11 = defineScenario({
  id: "SC-11",
  slug: "sc11",
  title: "WhatsApp window and business hours",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "inside the window opened by the importer, the answer is free text",
      flows: ["FL-055"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: MAIN.start, operations: [{ key: "a", model: "op-4472", etaOverride: MAIN.eta }] });
        const { operationId } = opOf(ctx);
        await firstRequest(ctx, operationId, MAIN.docsRequest);
        await importerSays(ctx, operationId, "¿Qué documentos me faltan todavía?");
        const answered = await awaitState(ctx, operationId, "a REPLY inside the window", (snapshot) => outbound(snapshot, { kind: "REPLY", status: [...SENT_STATUSES] }).length > 0);
        ctx.check(outbound(answered, { kind: "REPLY" })[0]?.template === undefined, "the answer is free text, not a template");
      },
    },
    {
      n: 2,
      title: "25 hours later the window is closed: a proactive message goes as a template",
      flows: ["FL-055"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceBy(ctx, operationId, 25 * 60);
        const since = (await ctx.snapshot(operationId)).clock.simNow;
        await ctx.qa("clock.fireMilestone", { operationId, milestone: "FOLLOWUP" });
        await awaitState(ctx, operationId, "the follow-up to the importer", (snapshot) => outbound(snapshot, { channel: "WHATSAPP", status: [...SENT_STATUSES], sinceSim: since }).length > 0);
        const settled = await ctx.settled(operationId);
        ctx.none(settled, "free-text WhatsApp messages after the window closed", outbound(settled, { channel: "WHATSAPP", sinceSim: since }).filter((message) => message.template === undefined));
      },
    },
    {
      n: 3,
      title: "a proactive message at 20:00 waits for 09:00 of the next business day",
      flows: ["FL-056"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceTo(ctx, operationId, MAIN.evening);
        await ctx.qa("clock.fireMilestone", { operationId, milestone: "FOLLOWUP_FINAL" });
        await deferredThenSent(ctx, operationId, { channel: "WHATSAPP", kind: ["REMINDER", "DOCS_REQUEST"] }, "CP-HOURS-AR", MAIN.nextMorning);
      },
    },
    {
      n: 4,
      title: "a request due on the 12/10 holiday goes out on Tuesday 13/10 at 09:00",
      flows: ["FL-056"],
      async run(ctx) {
        await createWorld(ctx, { suffix: "hol", startAtSim: HOLIDAY.start, operations: [{ key: "a", model: "op-4472", etaOverride: HOLIDAY.eta }] });
        const { operationId } = opOf(ctx, "a", "hol");
        await advanceTo(ctx, operationId, HOLIDAY.docsRequest);
        await deferredThenSent(ctx, operationId, { channel: "WHATSAPP", kind: "DOCS_REQUEST" }, "CP-HOURS-AR", HOLIDAY.tuesday);
      },
    },
  ],
});
