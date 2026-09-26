// SC-12 · the firm takes the conversation (docs/test-plan.md §4.5): op-4471, Thursday 15/10 09:58, after
// its first request. While the firm has the control nothing runs a turn (documents are still read); the
// firm writes through the same outbound pipeline (window or template); releasing it hands the context
// back to the agent.
import { SENT_STATUSES, decisions, outbound } from "./lib/asserts";
import { importerSays, firstRequest } from "./lib/flows";
import { defineScenario } from "./lib/steps";
import { advanceBy, awaitState, createWorld, opOf } from "./lib/world";

const START = "2026-10-15T09:58:00-03:00";
const DOCS_REQUEST = "2026-10-15T10:00:00-03:00";
const BROKER = "BROKER:brk-qa-runner";

export const sc12 = defineScenario({
  id: "SC-12",
  slug: "sc12",
  title: "Handoff to the firm and back",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the broker takes the conversation",
      flows: ["FL-067"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4471", authorizations: true }] });
        const { operationId } = opOf(ctx);
        await firstRequest(ctx, operationId, DOCS_REQUEST);
        await ctx.settled(operationId);
        await ctx.qa("console", { procedure: "conversation.take", input: { operationId } });
        const taken = await ctx.settled(operationId);
        ctx.check(taken.operation.control === "BROKER", "the firm has the conversation");
        ctx.check(decisions(taken, { action: "TAKEOVER" }).length === 1, "the takeover is audited");
      },
    },
    {
      n: 2,
      title: "inside the window the broker writes free text",
      flows: ["FL-068"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await importerSays(ctx, operationId, "Hola, ¿me pueden llamar más tarde?");
        await ctx.settled(operationId);
        await ctx.qa("console", { procedure: "conversation.send", input: { operationId, text: "Hola, te escribimos desde el estudio: lo vemos y te llamamos." } });
        const sent = await awaitState(ctx, operationId, "the firm's message sent", (snapshot) => outbound(snapshot, { kind: "BROKER_MESSAGE", status: [...SENT_STATUSES] }).length > 0);
        const message = outbound(sent, { kind: "BROKER_MESSAGE" })[0];
        ctx.check(message?.author === BROKER && message.template === undefined, "free text signed by the broker");
      },
    },
    {
      n: 3,
      title: "25 hours later the window is closed and the firm's message goes as a template",
      flows: ["FL-068"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await advanceBy(ctx, operationId, 25 * 60);
        const since = (await ctx.snapshot(operationId)).clock.simNow;
        await ctx.qa("console", { procedure: "conversation.send", input: { operationId, text: "Te recordamos que faltan documentos de la operación." } });
        const sent = await awaitState(ctx, operationId, "the firm's message after the window", (snapshot) => outbound(snapshot, { kind: "BROKER_MESSAGE", sinceSim: since, status: [...SENT_STATUSES] }).length > 0);
        ctx.check(outbound(sent, { kind: "BROKER_MESSAGE", sinceSim: since })[0]?.template !== undefined, "outside the window it is a template");
      },
    },
    {
      n: 4,
      title: "a message of the importer runs no turn while the firm has the conversation",
      flows: ["FL-069"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const since = (await ctx.snapshot(operationId)).clock.simNow;
        await importerSays(ctx, operationId, "¿Recibieron lo que les mandé?");
        const settled = await ctx.settled(operationId);
        ctx.check(decisions(settled, { action: "TURN_SKIPPED_CONTROL_BROKER" }).length >= 1, "the skipped turn is audited");
        ctx.none(settled, "messages of the agent", outbound(settled, { author: "AGENT", sinceSim: since }));
      },
    },
    {
      n: 5,
      title: "a document from the supplier is read, but no turn runs",
      flows: ["FL-069"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const since = (await ctx.snapshot(operationId)).clock.simNow;
        const { mailId } = (await ctx.qa("supplier.sendNow", { operationId, docTypes: ["CERTIFICATE_OF_ORIGIN"], version: 1 })) as { mailId: string };
        const outcome = (await ctx.qa("mail.outcome", { clockId: (await ctx.snapshot(operationId)).operation.clockId, mailId, timeoutSec: 300 })) as { outcome: string };
        ctx.check(outcome.outcome === "ENQUEUED", `the supplier's mail was ${outcome.outcome}`);
        const settled = await ctx.settled(operationId);
        ctx.check(settled.versions.some((version) => version.docType === "CERTIFICATE_OF_ORIGIN"), "the certificate was read");
        ctx.none(settled, "messages of the agent", outbound(settled, { author: "AGENT", sinceSim: since }));
      },
    },
    {
      n: 6,
      title: "released: the agent takes over with the firm's messages in context",
      flows: ["FL-070"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await ctx.qa("console", { procedure: "conversation.release", input: { operationId } });
        const released = await awaitState(ctx, operationId, "the BROKER_RELEASED turn", (snapshot) => snapshot.operation.control === "AGENT" && snapshot.turnNotes.some((note) => note.trigger === "BROKER_RELEASED"));
        ctx.check(decisions(released, { action: "RELEASE" }).length === 1, "the release is audited");
        const settled = await ctx.settled(operationId);
        const today = settled.clock.simNow.slice(0, 10);
        ctx.check(outbound(settled, { kind: "DOCS_REQUEST" }).filter((message) => message.sentAtSim.slice(0, 10) === today).length <= 1, "no duplicate DOCS_REQUEST the same day");
      },
    },
  ],
});
