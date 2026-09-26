// SC-06 · the supplier does not reply (docs/test-plan.md §4.5): op-4478 with a `NEVER` supplier in
// Europe/Rome and ETA Wednesday 28/10 08:00; Wednesday 21/10 09:58. Rome went back to UTC+1 on 25/10,
// so 09:00 there is 05:00 AR on Monday 26/10. Step 9 runs a clone of op-4475 whose supplier answers
// late (`LATE`, 30 h) in its own world.
import { SENT_STATUSES, decisions, milestone, openEscalations, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { delegateToSupplier, firstRequest, requestToSupplier, supplierReplies } from "./lib/flows";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { advanceTo, advanceToTimer, awaitState, createWorld, opOf, worldOf } from "./lib/world";
import { consoleQuery } from "./lib/console";

const START = "2026-10-21T09:58:00-03:00";
const ETA = "2026-10-28T08:00:00-03:00";
const AT = {
  docsRequest: "2026-10-21T10:00:00-03:00",
  followup: "2026-10-23T10:00:00-03:00",
  followupFinal: "2026-10-25T10:00:00-03:00",
  romeMorning: "2026-10-26T05:00:00-03:00",
  escalation: "2026-10-26T08:00:00-03:00",
  arMorning: "2026-10-26T09:00:00-03:00",
  arrival: "2026-10-28T08:00:00-03:00",
};
const LATE = { start: "2026-10-23T09:58:00-03:00", eta: "2026-10-30T10:00:00-03:00", docsRequest: "2026-10-23T10:00:00-03:00" };

/** At most one reminder per contact and simulated day (CP-ONE-PER-DAY). */
function remindersPerDay(snapshot: Awaited<ReturnType<ScenarioContext["snapshot"]>>): number {
  const days = new Map<string, number>();
  for (const message of outbound(snapshot, { channel: "EMAIL", kind: ["REMINDER", "DOCS_REQUEST"], status: [...SENT_STATUSES] })) {
    const day = new Date(Date.parse(message.sentAtSim) - 3 * 3_600_000).toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return Math.max(0, ...days.values());
}

export const sc06 = defineScenario({
  id: "SC-06",
  slug: "sc06",
  title: "The supplier never answers",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "request at 21/10 10:00; the email to Rome goes at 10:0x (15:0x there)",
      flows: ["FL-028"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4478", etaOverride: ETA, authorizations: true, supplierOverride: { behaviour: "NEVER" } }] });
        const { operationId } = opOf(ctx);
        await firstRequest(ctx, operationId, AT.docsRequest);
        const sent = await delegateToSupplier(ctx, operationId);
        ctx.check(outbound(sent, { channel: "EMAIL", kind: "DOCS_REQUEST", status: [...SENT_STATUSES] }).length === 1, "the email to Rome is not deferred");
      },
    },
    {
      n: 2,
      title: "FOLLOWUP on Friday 23/10 10:00 sends the reminders",
      flows: ["FL-028"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceTo(ctx, operationId, AT.followup);
        await awaitState(ctx, operationId, "a REMINDER to the supplier", (snapshot) => outbound(snapshot, { channel: "EMAIL", kind: "REMINDER", status: [...SENT_STATUSES] }).length > 0);
      },
    },
    {
      n: 3,
      title: "FOLLOWUP_FINAL on Sunday: WhatsApp waits for Monday 09:00 AR, email for 09:00 in Rome (05:00 AR)",
      flows: ["FL-028"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceTo(ctx, operationId, AT.followupFinal);
        const deferred = await awaitState(ctx, operationId, "both reminders deferred", (snapshot) => decisions(snapshot, { decision: "DEFER", ruleId: "CP-HOURS-AR" }).length > 0 && decisions(snapshot, { decision: "DEFER", ruleId: "CP-HOURS-SUPPLIER" }).length > 0);
        const due = deferred.pendingTimers.filter((timer) => timer.kind === "DEFERRED_SEND").map((timer) => Date.parse(timer.dueAtSim));
        ctx.check(due.includes(Date.parse(AT.romeMorning)) && due.includes(Date.parse(AT.arMorning)), "the two sends wait for 05:00 and 09:00 AR");
        await advanceToTimer(ctx, operationId, "DEFERRED_SEND");
        await awaitState(ctx, operationId, "the email reminder at 05:00", (snapshot) => outbound(snapshot, { channel: "EMAIL", kind: "REMINDER", status: [...SENT_STATUSES] }).some((message) => Date.parse(message.sentAtSim) === Date.parse(AT.romeMorning)));
      },
    },
    {
      n: 4,
      title: "FOLLOWUP_FINAL fired again the same day: the second reminder is deferred by CP-ONE-PER-DAY",
      flows: ["FL-057"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await ctx.settled(operationId);
        await ctx.qa("clock.fireMilestone", { operationId, milestone: "FOLLOWUP_FINAL" });
        await awaitState(ctx, operationId, "DEFER CP-ONE-PER-DAY", (snapshot) => decisions(snapshot, { decision: "DEFER", ruleId: "CP-ONE-PER-DAY" }).length > 0);
        const settled = await ctx.settled(operationId);
        ctx.check(remindersPerDay(settled) <= 1, "at most one reminder per contact per day");
      },
    },
    {
      n: 5,
      title: "ESCALATION at Monday 26/10 08:00 with documents missing",
      flows: ["FL-066"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceTo(ctx, operationId, AT.escalation);
        await awaitState(ctx, operationId, "MISSING_AT_ETA_48H escalation", (snapshot) => openEscalations(snapshot, "MISSING_AT_ETA_48H").length === 1);
      },
    },
    {
      n: 6,
      title: "the importer is told at 09:00",
      flows: ["FL-066"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceTo(ctx, operationId, AT.arMorning);
        await awaitState(ctx, operationId, "ESCALATION_NOTICE at 09:00", (snapshot) => outbound(snapshot, { kind: "ESCALATION_NOTICE", status: [...SENT_STATUSES] }).some((message) => Date.parse(message.sentAtSim) === Date.parse(AT.arMorning)));
      },
    },
    {
      n: 7,
      title: "the firm's demo mailbox has the escalation, with its assumptions labelled",
      flows: ["FL-066", "FL-084"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const snapshot = await awaitState(ctx, operationId, "the escalation in the firm's mailbox", (fresh) => fresh.mailbox.some((mail) => mail.bodyText.includes("supuesto")), WAITS.sesRoundTripSec);
        ctx.check(snapshot.mailbox.every((mail) => mail.firmId === "firm-qa"), "every mailbox message is of the operation's firm");
        const { clockId } = worldOf(ctx);
        const listed = await consoleQuery(ctx, "mailbox", "list", { clockId });
        const shown = listed.mailboxes.filter((mailbox) => mailbox.owner === "FIRM").flatMap((mailbox) => mailbox.messages.filter((mail) => mail.operationId === operationId));
        ensure(shown[0] !== undefined, "the console's mailbox lists the escalation of the operation");
        const opened = await consoleQuery(ctx, "mailbox", "get", { clockId, mailboxAddress: shown[0].mailboxAddress, mailboxMessageId: shown[0].mailboxMessageId });
        ctx.check(opened.bodyText.includes("supuesto"), "the body, as plain text, labels the assumptions");
      },
    },
    {
      n: 8,
      title: "ARRIVAL at 28/10 08:00 finds the dossier incomplete and at risk",
      flows: ["FL-071"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceTo(ctx, operationId, AT.arrival);
        const snapshot = await ctx.settled(operationId);
        ctx.check(milestone(snapshot, "ARRIVAL")?.status === "FIRED", "ARRIVAL fired");
        ctx.check(decisions(snapshot).some((row) => /AT_RISK|ARRIVAL/.test(row.action)), "the arrival with missing documents is recorded");
      },
    },
    {
      n: 9,
      title: "a clone of op-4475 answers 30 h late and the file goes on without duplicate reminders",
      flows: ["FL-028"],
      async run(ctx) {
        await createWorld(ctx, { suffix: "late", startAtSim: LATE.start, operations: [{ key: "a", model: "op-4475", etaOverride: LATE.eta, authorizations: true, supplierOverride: { behaviour: "LATE", delayHours: 30 } }] });
        const { operationId } = opOf(ctx, "a", "late");
        await requestToSupplier(ctx, operationId, LATE.docsRequest);
        await supplierReplies(ctx, operationId, (snapshot) => snapshot.versions.length > 0, "the late reply read");
        const settled = await ctx.settled(operationId);
        ctx.check(remindersPerDay(settled) <= 1, "no duplicate reminder around the late reply");
      },
    },
  ],
});
