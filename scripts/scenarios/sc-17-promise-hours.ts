// SC-17 · a promise and the supplier's business hours (docs/test-plan.md §4.5): clones of op-4480 (supplier
// in Europe/Madrid), Thursday 22/10 09:58, requests at 10:00 (15:00 in Madrid). Clone `a` promises
// ("We will send it tomorrow"): the agent schedules its own follow-up; clone `b` never answers, and its
// importer's message at 19:00 (midnight in Madrid) makes the agent write when Madrid opens.
import { SENT_STATUSES, decisions, inbound, nextPending, outbound, timers } from "./lib/asserts";
import { delegateToSupplier, expectTemplateRequest, importerSays, supplierReplies } from "./lib/flows";
import { defineScenario } from "./lib/steps";
import { advanceTo, advanceToTimer, awaitState, createWorld, opOf } from "./lib/world";

const START = "2026-10-22T09:58:00-03:00";
const ETA = "2026-10-29T10:00:00-03:00";
const DOCS_REQUEST = "2026-10-22T10:00:00-03:00";
const EVENING = "2026-10-23T19:00:00-03:00";

/** 09:00 in Madrid: 07:00 UTC in summer time, 08:00 UTC after 25/10. */
const isMadridNine = (instant: string): boolean => {
  const date = new Date(instant);
  return date.getUTCMinutes() === 0 && (date.getUTCHours() === 7 || date.getUTCHours() === 8);
};

export const sc17 = defineScenario({
  id: "SC-17",
  slug: "sc17",
  title: "Promise and business hours of the supplier",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the supplier answers “We will send it tomorrow”, without documents",
      flows: ["FL-027"],
      async run(ctx) {
        const base = { model: "op-4480", etaOverride: ETA, authorizations: true };
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", ...base, supplierOverride: { behaviour: "PROMISE" } }, { key: "b", ...base, supplierOverride: { behaviour: "NEVER" } }] });
        const [a, b] = [opOf(ctx, "a").operationId, opOf(ctx, "b").operationId];
        await advanceTo(ctx, a, DOCS_REQUEST);
        for (const operationId of [a, b]) {
          await expectTemplateRequest(ctx, operationId);
          await delegateToSupplier(ctx, operationId);
        }
        const promised = await supplierReplies(ctx, a, (snapshot) => inbound(snapshot, { channel: "EMAIL" }).some((message) => message.attachments.length === 0), "the promise without attachments");
        ctx.check(promised.versions.length === 0, "no document came with the promise");
      },
    },
    {
      n: 2,
      title: "the agent schedules its own follow-up for Friday 23/10 10:00 in Madrid",
      flows: ["FL-027"],
      async run(ctx) {
        const scheduled = await awaitState(ctx, opOf(ctx, "a").operationId, "FOLLOWUP_DUE scheduled", (snapshot) => timers(snapshot, { kind: "FOLLOWUP_DUE", status: "SCHEDULED" }).length === 1);
        const due = nextPending(scheduled, "FOLLOWUP_DUE")?.dueAtSim ?? "";
        ctx.check(Date.parse(due) === Date.parse("2026-10-23T05:00:00-03:00"), `the follow-up is due at ${due}, expected 23/10 10:00 in Madrid`);
      },
    },
    {
      n: 3,
      title: "at the follow-up, the reminder goes out",
      flows: ["FL-027"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        await advanceToTimer(ctx, operationId, "FOLLOWUP_DUE");
        await awaitState(ctx, operationId, "REMINDER to the supplier", (snapshot) => outbound(snapshot, { channel: "EMAIL", kind: "REMINDER", status: [...SENT_STATUSES] }).length > 0);
      },
    },
    {
      n: 4,
      title: "a message of the importer at 19:00 (midnight in Madrid) makes the agent write: deferred",
      flows: ["FL-033"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "b");
        await advanceTo(ctx, operationId, EVENING);
        await importerSays(ctx, operationId, "¿Le pueden volver a escribir al proveedor? Es urgente.");
        const deferred = await awaitState(ctx, operationId, "the email deferred by CP-HOURS-SUPPLIER", (snapshot) => decisions(snapshot, { decision: "DEFER", ruleId: "CP-HOURS-SUPPLIER" }).length > 0 && nextPending(snapshot, "DEFERRED_SEND") !== undefined);
        ctx.check(isMadridNine(nextPending(deferred, "DEFERRED_SEND")?.dueAtSim ?? ""), "the email waits for 09:00 in Madrid");
      },
    },
    {
      n: 5,
      title: "advanced: the email goes out at 09:00 in Madrid",
      flows: ["FL-033"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "b");
        const releasedAt = await advanceToTimer(ctx, operationId, "DEFERRED_SEND");
        const sent = await awaitState(ctx, operationId, "the deferred email sent", (snapshot) => outbound(snapshot, { channel: "EMAIL", status: [...SENT_STATUSES] }).some((message) => Date.parse(message.sentAtSim) === Date.parse(releasedAt)));
        ctx.check(outbound(sent, { channel: "EMAIL", status: [...SENT_STATUSES] }).every((message) => isMadridNine(message.sentAtSim) || Date.parse(message.sentAtSim) < Date.parse(EVENING)), "every email after the evening left at 09:00 in Madrid");
      },
    },
  ],
});
