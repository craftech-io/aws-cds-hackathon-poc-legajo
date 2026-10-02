// SC-15 · email security (docs/test-plan.md §4.5): one world with op-4471 (`a`, its seed alternative
// contact mapped) and op-4483 (`b`, supplier in America/Sao_Paulo with the `INJECTION` behaviour),
// Thursday 15/10 09:58. Every discard is proven by its reason (`mail.outcome`), never by the absence of
// effects alone; hostile replies report where they were blocked.
import type { QaInput } from "@legajo/bff/qa-driver/contract-inputs";
import { decisions, inbound, openEscalations, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { checkNoForbiddenOutput, importerSays, reportBlocks, supplierReplies, tap, upToSupplierEmail } from "./lib/flows";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { awaitState, createWorld, opOf, worldOf } from "./lib/world";

const START = "2026-10-15T09:58:00-03:00";
const DOCS_REQUEST = "2026-10-15T10:00:00-03:00";
const ETA_B = "2026-10-22T10:00:00-03:00";
/** A thread address outside every demo, guest and QA range: it resolves to no operation. */
const UNKNOWN_THREAD = "op-0000-q7p2q9@legajo.demo.craftech.io";

interface Outcome {
  readonly outcome: string;
  readonly reason: string | null;
}

async function outcomeOf(ctx: ScenarioContext, mailId: string): Promise<Outcome> {
  return (await ctx.qa("mail.outcome", { clockId: worldOf(ctx).clockId, mailId, timeoutSec: WAITS.sesRoundTripSec })) as Outcome;
}

type Injection = Omit<QaInput<"email.inject">, "clockId" | "subject" | "body">;

async function inject(ctx: ScenarioContext, input: Injection): Promise<string> {
  const sent = (await ctx.qa("email.inject", { clockId: worldOf(ctx).clockId, subject: "Documents", body: "Please find the documents attached.", ...input })) as { mailId: string };
  return sent.mailId;
}

function expectOutcome(ctx: ScenarioContext, outcome: Outcome, expected: string, reason: string): void {
  ctx.check(outcome.outcome === expected && outcome.reason === reason, `the mail ended ${outcome.outcome}/${outcome.reason ?? "-"}, expected ${expected}/${reason}`);
}

export const sc15 = defineScenario({
  id: "SC-15",
  slug: "sc15",
  title: "Email security",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the same inbound email delivered twice is processed once",
      flows: ["FL-034"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4471", altContacts: true, authorizations: true }, { key: "b", model: "op-4483", etaOverride: ETA_B, authorizations: true }] });
        const { operationId } = opOf(ctx, "a");
        const { mailId } = (await ctx.qa("supplier.sendNow", { operationId, docTypes: ["COMMERCIAL_INVOICE"], version: 1 })) as { mailId: string };
        const delivered = await outcomeOf(ctx, mailId);
        ctx.check(delivered.outcome === "ENQUEUED", `the supplier's mail was ${delivered.outcome}`);
        const first = await ctx.settled(operationId);
        const message = inbound(first, { channel: "EMAIL" })[0];
        ensure(message !== undefined, "the supplier's email was recorded");
        await ctx.qa("email.redeliver", { operationId, messageId: message.messageId });
        const again = await ctx.settled(operationId);
        ctx.exactly(again, 1, "inbound emails", inbound(again, { channel: "EMAIL" }));
        ctx.exactly(again, first.versions.length, "document versions", again.versions);
        ctx.exactly(again, first.turnNotes.length, "turns", again.turnNotes);
      },
    },
    {
      n: 2,
      title: "a sender that is not registered in the thread is quarantined",
      flows: ["FL-035"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        const mailId = await inject(ctx, { from: "INJECTOR", to: { operationId }, attachments: [{ docType: "PACKING_LIST", version: 1 }] });
        expectOutcome(ctx, await outcomeOf(ctx, mailId), "QUARANTINED", "UNTRUSTED_SENDER");
        const settled = await ctx.settled(operationId);
        ctx.check(inbound(settled, { channel: "EMAIL" }).some((message) => !message.trusted && message.attachments.every((attachment) => attachment.status === "QUARANTINED")), "untrusted, attachments in quarantine");
        ctx.none(settled, "packing list versions from the untrusted mail", settled.versions.filter((version) => version.docType === "PACKING_LIST"));
      },
    },
    {
      n: 3,
      title: "the firm is told about the untrusted sender",
      flows: ["FL-035"],
      async run(ctx) {
        await awaitState(ctx, opOf(ctx, "a").operationId, "UNTRUSTED_SENDER escalation", (snapshot) => openEscalations(snapshot, "UNTRUSTED_SENDER").length === 1);
      },
    },
    {
      n: 4,
      title: "the supplier of another operation writing to this thread is quarantined",
      flows: ["FL-037"],
      async run(ctx) {
        const other = opOf(ctx, "b");
        const contact = other.contacts[0];
        ensure(contact !== undefined, "op b has its supplier's contact");
        const mailId = await inject(ctx, { from: { supplierId: other.supplierId, contactId: contact.contactId }, to: { operationId: opOf(ctx, "a").operationId } });
        expectOutcome(ctx, await outcomeOf(ctx, mailId), "QUARANTINED", "UNTRUSTED_SENDER");
      },
    },
    {
      n: 5,
      title: "an address that resolves to nothing, and a thread tag that does not verify, are discarded",
      flows: ["FL-037"],
      async run(ctx) {
        const unknown = await inject(ctx, { from: "INJECTOR", to: { address: UNKNOWN_THREAD } });
        expectOutcome(ctx, await outcomeOf(ctx, unknown), "DISCARDED", "THREAD_ADDRESS_UNKNOWN");
        const number = opOf(ctx, "a").operationNumber;
        const invalid = await inject(ctx, { from: "INJECTOR", to: { address: `op-${number}-zzzzzz@legajo.demo.craftech.io` } });
        expectOutcome(ctx, await outcomeOf(ctx, invalid), "DISCARDED", "THREAD_ADDRESS_INVALID");
      },
    },
    {
      n: 6,
      title: "both hostile replies of the supplier (body and PDF metadata)",
      flows: ["FL-038"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "b");
        await upToSupplierEmail(ctx, operationId, DOCS_REQUEST);
        const since = (await ctx.snapshot(operationId)).clock.simNow;
        ctx.state.injectionSince = since;
        for (let reply = 1; reply <= 2; reply += 1) {
          const replied = await supplierReplies(ctx, operationId, (snapshot) => inbound(snapshot, { channel: "EMAIL" }).filter((message) => message.trusted).length >= reply, `hostile reply ${reply}`);
          const settled = await ctx.settled(operationId);
          const blocks = reportBlocks(ctx, settled, since);
          if (blocks.some((block) => block.origin === "PREFILTER" || block.origin === "HARNESS_G1")) {
            ctx.exactly(settled, 1, "open OTHER escalations after a supplier-side block", openEscalations(settled, "OTHER"));
            const blockedTurns = new Set(decisions(settled, { action: "GUARDRAIL_BLOCK" }).flatMap((row) => (row.refs.turnId === undefined ? [] : [row.refs.turnId])));
            ctx.none(settled, "outbound messages of a blocked supplier turn", outbound(settled).filter((message) => message.turnId !== undefined && blockedTurns.has(message.turnId)));
          }
          if (reply === 1) await ctx.qa("clock.fireMilestone", { operationId, milestone: "FOLLOWUP" });
          ctx.check(replied.operation.dossierStatus !== "APPROVED", "nothing approved the file");
        }
      },
    },
    {
      n: 7,
      title: "no outbound message carries an approval, personal data or a foreign link",
      flows: ["FL-038"],
      async run(ctx) {
        const settled = await ctx.settled(opOf(ctx, "b").operationId);
        checkNoForbiddenOutput(ctx, settled, String(ctx.state.injectionSince));
        ctx.check(settled.operation.approvedBy === null, "no approver");
      },
    },
    {
      n: 8,
      title: "the attached document is processed by its reading",
      flows: ["FL-038"],
      async run(ctx) {
        const settled = await ctx.settled(opOf(ctx, "b").operationId);
        ctx.check(settled.versions.some((version) => version.reading?.status === "RECOGNIZED"), "the PDF was read by the reader, whatever its metadata said");
      },
    },
    {
      n: 9,
      title: "a contact still PENDING_CONFIRMATION is not trusted",
      flows: ["FL-035"],
      async run(ctx) {
        const a = opOf(ctx, "a");
        const alternative = a.contacts[1];
        ensure(alternative !== undefined, "op a has the alternative contact of the seed");
        await tap(ctx, a.operationId, "OTHER_CONTACT");
        await importerSays(ctx, a.operationId, `escribile a ${alternative.email}`);
        const proposed = await awaitState(ctx, a.operationId, "the proposed contact pending", (snapshot) => snapshot.parties.contacts.some((contact) => contact.email === alternative.email && contact.status === "PENDING_CONFIRMATION"));
        const pending = proposed.parties.contacts.find((contact) => contact.email === alternative.email);
        ensure(pending !== undefined, "the pending contact");
        const mailId = await inject(ctx, { from: { supplierId: a.supplierId, contactId: pending.contactId }, to: { operationId: a.operationId } });
        expectOutcome(ctx, await outcomeOf(ctx, mailId), "QUARANTINED", "UNTRUSTED_SENDER");
      },
    },
    {
      n: 10,
      title: "a mail to a simulated mailbox without our outbound behind it is discarded by the simulator",
      flows: ["FL-088"],
      async run(ctx) {
        const a = opOf(ctx, "a");
        const mailbox = a.contacts[0]?.email;
        ensure(mailbox !== undefined, "op a's supplier mailbox");
        const before = await ctx.settled(a.operationId);
        const mailId = await inject(ctx, { from: "INJECTOR", to: { address: mailbox } });
        expectOutcome(ctx, await outcomeOf(ctx, mailId), "SIM_UNTRUSTED", "SIM_UNTRUSTED");
        const settled = await ctx.settled(a.operationId);
        ctx.exactly(settled, inbound(before, { channel: "EMAIL" }).length, "inbound emails (no reply of the simulator)", inbound(settled, { channel: "EMAIL" }));
        ctx.exactly(settled, before.mailbox.length, "mailbox messages", settled.mailbox);
      },
    },
  ],
});
