// SC-21 · complaint and auto-reply (docs/test-plan.md §4.5): a clone of op-4482 whose supplier's contact
// is its own address of the SES mailbox simulator for complaints, and a clone of op-4481 whose supplier
// first answers "Out of office" (`AUTO_REPLY`) and two simulated hours later with the documents. Both
// requests at Thursday 15/10 10:00.
import { SENT_STATUSES, allValid, decisions, openEscalations, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { expectTemplateRequest, delegateToSupplier, emailOutWhenAllowed, supplierReplies } from "./lib/flows";
import { defineScenario } from "./lib/steps";
import { advanceTo, advanceToTimer, awaitState, createWorld, opOf } from "./lib/world";

const START = "2026-10-15T09:58:00-03:00";
const ETA = "2026-10-22T10:00:00-03:00";
const DOCS_REQUEST = "2026-10-15T10:00:00-03:00";

export const sc21 = defineScenario({
  id: "SC-21",
  slug: "sc21",
  title: "Complaint and auto-reply",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the supplier's contact complains: the contact is COMPLAINED",
      flows: ["FL-031"],
      async run(ctx) {
        await createWorld(ctx, {
          startAtSim: START,
          operations: [
            { key: "a", model: "op-4482", etaOverride: ETA, authorizations: true, supplierOverride: { behaviour: "COMPLAINT" } },
            { key: "b", model: "op-4481", etaOverride: ETA, authorizations: true, supplierOverride: { behaviour: "AUTO_REPLY" } },
          ],
        });
        const [a, b] = [opOf(ctx, "a").operationId, opOf(ctx, "b").operationId];
        await advanceTo(ctx, a, DOCS_REQUEST);
        for (const operationId of [a, b]) {
          await expectTemplateRequest(ctx, operationId);
          await delegateToSupplier(ctx, operationId);
          await emailOutWhenAllowed(ctx, operationId, (snapshot) => outbound(snapshot, { channel: "EMAIL", kind: "DOCS_REQUEST", status: [...SENT_STATUSES, "COMPLAINED"] }).length > 0);
        }
        await awaitState(ctx, a, "the contact COMPLAINED", (snapshot) => snapshot.parties.contacts.some((contact) => contact.status === "COMPLAINED"), WAITS.sesRoundTripSec);
      },
    },
    {
      n: 2,
      title: "the complaint is escalated and no email follows to that contact",
      flows: ["FL-031"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        await awaitState(ctx, operationId, "NO_VALID_CONTACT escalation", (snapshot) => openEscalations(snapshot, "NO_VALID_CONTACT").length === 1);
        const settled = await ctx.settled(operationId);
        ctx.exactly(settled, 1, "emails to the complaining contact", outbound(settled, { channel: "EMAIL" }));
      },
    },
    {
      n: 3,
      title: "the auto-reply is ignored: no turn for it",
      flows: ["FL-032"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "b");
        await awaitState(ctx, operationId, "the auto-reply scheduled", (snapshot) => snapshot.pendingTimers.some((timer) => timer.kind === "SIM_REPLY"), WAITS.sesRoundTripSec);
        const turnsBefore = (await ctx.settled(operationId)).turnNotes.length;
        await advanceToTimer(ctx, operationId, "SIM_REPLY");
        await awaitState(ctx, operationId, "AUTO_REPLY_IGNORED", (snapshot) => decisions(snapshot, { action: "AUTO_REPLY_IGNORED" }).length === 1, WAITS.sesRoundTripSec);
        const settled = await ctx.settled(operationId);
        ctx.exactly(settled, turnsBefore, "turns (none for the auto-reply)", settled.turnNotes);
        ctx.none(settled, "document versions from the auto-reply", settled.versions);
      },
    },
    {
      n: 4,
      title: "two simulated hours later the real reply arrives",
      flows: ["FL-032"],
      async run(ctx) {
        await supplierReplies(ctx, opOf(ctx, "b").operationId, allValid, "the documents of the real reply");
      },
    },
  ],
});
