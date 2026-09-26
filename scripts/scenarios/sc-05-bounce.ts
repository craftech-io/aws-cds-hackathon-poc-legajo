// SC-05 · bounce (docs/test-plan.md §4.5): two clones of op-4474 (supplier in Asia/Kolkata), each with
// its own importer and supplier, whose contact is its own address of the SES mailbox simulator
// (`bounce+<runId>-sc05-<key>@simulator.amazonses.com`); ETA Tuesday 27/10 10:00 (request 20/10 10:00);
// clone `a` also gets the alternative contact of the seed (`altContacts`). 09:00 in Kolkata is 00:30
// AR of the next day.
import { SENT_STATUSES, decisions, inbound, openEscalations, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { deferredThenSent, delegateToSupplier, emailOutWhenAllowed, expectTemplateRequest, importerSays, tap } from "./lib/flows";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { advanceTo, advanceToTimer, awaitState, createWorld, opOf } from "./lib/world";

const START = "2026-10-20T09:58:00-03:00";
const ETA = "2026-10-27T10:00:00-03:00";
const DOCS_REQUEST = "2026-10-20T10:00:00-03:00";
const KOLKATA_MORNING = "2026-10-21T00:30:00-03:00";
const AR_MORNING = "2026-10-21T09:00:00-03:00";
/** Outside the fence: a reserved domain (RFC 2606), never a real one. */
const FENCED_OUT = "ventas@example.com";

async function bounced(ctx: ScenarioContext, operationId: string) {
  return awaitState(ctx, operationId, "the email BOUNCED and the contact BOUNCED", (snapshot) => outbound(snapshot, { channel: "EMAIL", status: "BOUNCED" }).length > 0 && snapshot.parties.contacts.some((contact) => contact.status === "BOUNCED"), WAITS.sesRoundTripSec);
}

export const sc05 = defineScenario({
  id: "SC-05",
  slug: "sc05",
  title: "Permanent bounce and the importer's other contact",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "both clones confirm the contact; the emails wait for 09:00 in Kolkata and bounce for real",
      flows: ["FL-029"],
      async run(ctx) {
        const base = { model: "op-4474", etaOverride: ETA, authorizations: true, supplierOverride: { behaviour: "BOUNCE" as const } };
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", ...base, altContacts: true }, { key: "b", ...base }] });
        const [a, b] = [opOf(ctx, "a").operationId, opOf(ctx, "b").operationId];
        await advanceTo(ctx, a, DOCS_REQUEST);
        for (const operationId of [a, b]) {
          await expectTemplateRequest(ctx, operationId);
          await delegateToSupplier(ctx, operationId);
        }
        await deferredThenSent(ctx, a, { channel: "EMAIL", kind: "DOCS_REQUEST" }, "CP-HOURS-SUPPLIER", KOLKATA_MORNING);
        for (const operationId of [a, b]) await bounced(ctx, operationId);
      },
    },
    {
      n: 2,
      title: "the agent asks the importer for another contact at 21/10 09:00",
      flows: ["FL-029"],
      async run(ctx) {
        await deferredThenSent(ctx, opOf(ctx, "a").operationId, { channel: "WHATSAPP", kind: "CONTACT_REQUEST" }, "CP-HOURS-AR", AR_MORNING);
        await awaitState(ctx, opOf(ctx, "b").operationId, "CONTACT_REQUEST to the second importer", (snapshot) => outbound(snapshot, { kind: "CONTACT_REQUEST", status: [...SENT_STATUSES] }).length > 0);
      },
    },
    {
      n: 3,
      title: "the importer writes the supplier's other address",
      flows: ["FL-014"],
      async run(ctx) {
        const alternative = opOf(ctx, "a").contacts[1];
        ensure(alternative !== undefined, "clone a has the alternative contact of the seed");
        ctx.state.alternative = alternative.email;
        await tap(ctx, opOf(ctx, "a").operationId, "OTHER_CONTACT");
        await importerSays(ctx, opOf(ctx, "a").operationId, `escribile a ${alternative.email}`);
      },
    },
    {
      n: 4,
      title: "the importer confirms the proposed contact with the buttons",
      flows: ["FL-014"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        await awaitState(ctx, operationId, "a proposed contact to confirm", (snapshot) => snapshot.parties.contacts.some((contact) => contact.email === ctx.state.alternative && contact.status === "PENDING_CONFIRMATION"));
        await tap(ctx, operationId, "CONFIRM_CONTACT");
        await awaitState(ctx, operationId, "the new contact ACTIVE", (snapshot) => snapshot.parties.contacts.some((contact) => contact.email === ctx.state.alternative && contact.status === "ACTIVE"));
      },
    },
    {
      n: 5,
      title: "the email goes to the new contact",
      flows: ["FL-014"],
      async run(ctx) {
        const address = String(ctx.state.alternative);
        await emailOutWhenAllowed(ctx, opOf(ctx, "a").operationId, (snapshot) => outbound(snapshot, { channel: "EMAIL", status: [...SENT_STATUSES] }).some((message) => message.to === address));
      },
    },
    {
      n: 6,
      title: "second clone: an address outside the fence is refused and escalated",
      flows: ["FL-015"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "b");
        await importerSays(ctx, operationId, `escribile a ${FENCED_OUT}`);
        await awaitState(ctx, operationId, "the refusal of the fence", (snapshot) => decisions(snapshot, { decision: "DENY", ruleId: "CP-RECIPIENT-FENCE" }).length > 0 && inbound(snapshot, { channel: "WHATSAPP" }).length > 0);
        const settled = await ctx.settled(operationId);
        ctx.none(settled, "contacts at the fenced-out address", settled.parties.contacts.filter((contact) => contact.email === FENCED_OUT));
        ctx.check(openEscalations(settled, "OTHER").length === 1, "the refusal is escalated");
      },
    },
    {
      n: 7,
      title: "second clone without an alternative: CONTACT_CHECK a day later escalates NO_VALID_CONTACT",
      flows: ["FL-030"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "b");
        await advanceToTimer(ctx, operationId, "CONTACT_CHECK");
        await awaitState(ctx, operationId, "NO_VALID_CONTACT escalation", (snapshot) => openEscalations(snapshot, "NO_VALID_CONTACT").length === 1);
        const settled = await ctx.settled(operationId);
        const bounceAt = outbound(settled, { channel: "EMAIL", status: "BOUNCED" })[0]?.sentAtSim ?? START;
        ctx.none(settled, "emails after the bounce", outbound(settled, { channel: "EMAIL" }).filter((message) => Date.parse(message.sentAtSim) > Date.parse(bounceAt)));
      },
    },
  ],
});
