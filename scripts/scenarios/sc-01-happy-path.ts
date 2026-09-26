// SC-01 · happy path (docs/test-plan.md §4.5): op-4471 with a `PROMPT` supplier in Qingdao (UTC+8, no
// business hour in common with Argentina), Thursday 15/10 09:55. The request at 15/10 10:00 fires by
// the real Scheduler; the email waits for 16/10 09:00 in Qingdao (15/10 22:00 AR); the reply arrives at
// 22:10; the importer's notice waits for 16/10 09:00 AR; the Saturday follow-up is skipped; approval's
// notice waits for Monday 19/10 09:00; dispatch statuses close the operation.
import { SENT_STATUSES, allValid, decisions, milestone, outbound } from "./lib/asserts";
import { checkSupplierEmail, deferredThenSent, expectTemplateRequest, supplierReplies } from "./lib/flows";
import { consoleQuery } from "./lib/console";
import { defineScenario } from "./lib/steps";
import { advanceTo, awaitState, createWorld, opOf, schedulerProbe, worldOf } from "./lib/world";

const START = "2026-10-15T09:55:00-03:00";
const DOCS_REQUEST = "2026-10-15T10:00:00-03:00";
const QINGDAO_MORNING = "2026-10-15T22:00:00-03:00";
const AR_MORNING = "2026-10-16T09:00:00-03:00";
const SATURDAY_FOLLOWUP = "2026-10-17T10:00:00-03:00";
const MONDAY_MORNING = "2026-10-19T09:00:00-03:00";
const DISPATCH_AT = "2026-10-19T09:30:00-03:00";

export const sc01 = defineScenario({
  id: "SC-01",
  slug: "sc01",
  title: "Happy path of op-4471",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "world from the platform, with the supplier authorized",
      flows: ["FL-003", "FL-005"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4471", authorizations: true, supplierOverride: { behaviour: "PROMPT" } }] });
        const snapshot = await ctx.settled(opOf(ctx).operationId);
        ctx.check(snapshot.parties.authorizations.some((row) => row.supplierId === snapshot.operation.supplierId && row.authorized), "the importer authorized the agent to write to the supplier");
        ctx.check(snapshot.operation.dossierStatus === "OPEN" && snapshot.documents.length === 3, "the dossier opens with its three documents");
        ctx.check(milestone(snapshot, "DOCS_REQUEST")?.dueAtSim !== undefined && Date.parse(milestone(snapshot, "DOCS_REQUEST")?.dueAtSim ?? "") === Date.parse(DOCS_REQUEST), "DOCS_REQUEST is due at ETA − 7 days, 10:00");
      },
    },
    {
      n: 2,
      title: "the real Scheduler fires DOCS_REQUEST at 15/10 10:00; the template goes out",
      flows: ["FL-007", "FL-065"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await schedulerProbe(ctx, operationId, DOCS_REQUEST);
        await expectTemplateRequest(ctx, operationId);
      },
    },
    {
      n: 3,
      title: "“Los manda el proveedor” from the phone simulator asks to confirm the contact",
      flows: ["FL-011", "FL-083"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await ctx.qa("wa.inbound", { operationId, message: { type: "button", action: "SUPPLIER_SENDS" } });
        const snapshot = await awaitState(ctx, operationId, "CONTACT_CONFIRMATION", (fresh) => outbound(fresh, { kind: "CONTACT_CONFIRMATION" }).length > 0);
        const question = outbound(snapshot, { kind: "CONTACT_CONFIRMATION" })[0];
        ctx.check(question?.buttons.filter((button) => button.nonce !== undefined).length === 3, "the confirmation carries three nonces");
        ctx.check(snapshot.messages.some((message) => message.direction === "IN" && message.channel === "WHATSAPP" && message.simulated), "the button entered as a simulated WhatsApp message");
      },
    },
    {
      n: 4,
      title: "confirmed: the email waits for 09:00 in Qingdao (22:00 AR) and then goes out in English",
      flows: ["FL-012"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await ctx.qa("wa.inbound", { operationId, message: { type: "button", action: "CONFIRM_CONTACT" } });
        const sent = await deferredThenSent(ctx, operationId, { channel: "EMAIL", kind: "DOCS_REQUEST" }, "CP-HOURS-SUPPLIER", QINGDAO_MORNING);
        checkSupplierEmail(ctx, sent, "DOCS_REQUEST");
        ctx.check(sent.parties.contacts.some((contact) => contact.status === "ACTIVE" && contact.confirmedBy === "IMPORTER"), "the contact is ACTIVE, confirmed by the importer");
        ctx.check(sent.documents.some((row) => row.requestedFrom === "SUPPLIER"), "the documents are requested from the supplier");
      },
    },
    {
      n: 5,
      title: "the supplier replies at 22:10 through SES; the reply is trusted and PL and CO are valid",
      flows: ["FL-021"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await supplierReplies(ctx, operationId, allValid, "the three documents VALID");
      },
    },
    {
      n: 6,
      title: "ready for review; “Llegaron los documentos” waits for 16/10 09:00 AR",
      flows: ["FL-021", "FL-072"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await awaitState(ctx, operationId, "READY_FOR_REVIEW", (snapshot) => snapshot.operation.dossierStatus === "READY_FOR_REVIEW");
        await deferredThenSent(ctx, operationId, { channel: "WHATSAPP", counterpart: "IMPORTER", kind: ["REPLY", "NO_ACTION_NEEDED"] }, "CP-HOURS-AR", AR_MORNING);
      },
    },
    {
      n: 7,
      title: "Saturday's follow-up is skipped without a message; approval's notice waits for Monday 09:00",
      flows: ["FL-008", "FL-073"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceTo(ctx, operationId, SATURDAY_FOLLOWUP);
        const saturday = await ctx.settled(operationId);
        ctx.check(milestone(saturday, "FOLLOWUP")?.status === "SKIPPED", "FOLLOWUP is SKIPPED on a complete dossier");
        ctx.check(decisions(saturday, { action: "MILESTONE_SKIPPED" }).length > 0, "the skip is audited");
        ctx.none(saturday, "messages after the skipped follow-up", outbound(saturday, { sinceSim: SATURDAY_FOLLOWUP }));
        await ctx.qa("console", { procedure: "dossier.approve", input: { operationId } });
        const approved = await deferredThenSent(ctx, operationId, { channel: "WHATSAPP", kind: "APPROVAL_NOTICE" }, "CP-HOURS-AR", MONDAY_MORNING);
        ctx.check(approved.operation.dossierStatus === "APPROVED" && approved.operation.approvedBy === "brk-qa-runner", "approved by the firm's broker");
        ctx.check(outbound(approved, { kind: "APPROVAL_NOTICE" })[0]?.template?.name === "legajo_aprobado", "the notice is the template legajo_aprobado");
      },
    },
    {
      n: 8,
      title: "dispatch statuses on Monday 09:3x: three DISPATCH_STATUS and the operation closes",
      flows: ["FL-077"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceTo(ctx, operationId, DISPATCH_AT);
        await ctx.qa("feed.customs", { operationId, status: "OFICIALIZADO" });
        await ctx.qa("feed.customs", { operationId, status: "CANAL_ASIGNADO", channel: "VERDE" });
        await ctx.qa("feed.customs", { operationId, status: "LIBERADO" });
        const closed = await awaitState(ctx, operationId, "three dispatch notices", (snapshot) => outbound(snapshot, { kind: "DISPATCH_STATUS", status: [...SENT_STATUSES] }).length >= 3);
        const settled = await ctx.settled(operationId);
        ctx.exactly(settled, 3, "DISPATCH_STATUS messages", outbound(settled, { kind: "DISPATCH_STATUS" }));
        ctx.check(closed.operation.dispatch.status === "LIBERADO", "the dispatch is LIBERADO");
      },
    },
    {
      n: 9,
      title: "the console's dossier and timeline match the stored state",
      flows: ["FL-081"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const snapshot = await ctx.settled(operationId);
        const dossier = await consoleQuery(ctx, "operations", "get", { operationId });
        ctx.check(dossier.operation.dossierStatus === snapshot.operation.dossierStatus, "operations.get shows the stored dossier status");
        for (const row of snapshot.documents) ctx.check(dossier.documents.some((shown) => shown.docType === row.docType && shown.status === row.status), `operations.get shows ${row.docType} ${row.status}`);
        const timeline = await consoleQuery(ctx, "operations", "timeline", { operationId });
        const order = timeline.entries.map((entry) => Date.parse(entry.atSim));
        ctx.check(timeline.entries.filter((entry) => entry.type === "MESSAGE").length === snapshot.messages.length, "the timeline shows every message");
        ctx.check(order.every((at, index) => index === 0 || at >= (order[index - 1] ?? at)), "the timeline is in simulated order");
      },
    },
    {
      n: 10,
      title: "policy audit of the world: 0 violations",
      flows: [],
      async run(ctx) {
        const audit = (await ctx.qa("policyAudit.run", { clockId: worldOf(ctx).clockId })) as { violations: unknown[] };
        ctx.check(audit.violations.length === 0, `${audit.violations.length} policy violation(s)`);
      },
    },
  ],
});
