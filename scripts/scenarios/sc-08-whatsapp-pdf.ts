// SC-08 · a PDF through WhatsApp (docs/test-plan.md §4.5): op-4471, Thursday 15/10 09:58. The document
// enters through the phone simulator's path (`sim-media:`), goes to the reader like any other PDF and
// the importer gets an answer; an image gets the fixed answer of `copy/es-AR.ts` and never an intake.
import { SENT_STATUSES, document, inbound, outbound } from "./lib/asserts";
import { firstRequest } from "./lib/flows";
import { defineScenario } from "./lib/steps";
import { awaitState, createWorld, opOf } from "./lib/world";

const START = "2026-10-15T09:58:00-03:00";
const DOCS_REQUEST = "2026-10-15T10:00:00-03:00";
/** The corrected packing list of op-4471's template PDFs (v1 carries the seeded weight mismatch). */
const CLEAN_PACKING_LIST = 2;

export const sc08 = defineScenario({
  id: "SC-08",
  slug: "sc08",
  title: "PDF through WhatsApp",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the importer sends the packing list as a WhatsApp document",
      flows: ["FL-017", "FL-083"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4471" }] });
        const { operationId } = opOf(ctx);
        await firstRequest(ctx, operationId, DOCS_REQUEST);
        const sent = (await ctx.qa("wa.inbound", { operationId, message: { type: "document", docType: "PACKING_LIST", version: CLEAN_PACKING_LIST } })) as { wamid: string };
        ctx.note("wamid", sent.wamid);
        await awaitState(ctx, operationId, "the document received", (snapshot) => inbound(snapshot, { channel: "WHATSAPP" }).some((message) => message.attachments.length > 0));
      },
    },
    {
      n: 2,
      title: "the packing list is read and valid; the importer gets the answer",
      flows: ["FL-017"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const valid = await awaitState(ctx, operationId, "packing list VALID from WhatsApp", (snapshot) => document(snapshot, "PACKING_LIST").status === "VALID");
        ctx.check(valid.versions.some((version) => version.docType === "PACKING_LIST" && version.source.channel === "WHATSAPP"), "the version came from WhatsApp");
        await awaitState(ctx, operationId, "the answer to the importer", (snapshot) => outbound(snapshot, { channel: "WHATSAPP", kind: "REPLY", status: [...SENT_STATUSES] }).length > 0);
      },
    },
    {
      n: 3,
      title: "an image gets the fixed answer and no intake",
      flows: ["FL-018"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const before = (await ctx.settled(operationId)).versions.length;
        await ctx.qa("wa.inbound", { operationId, message: { type: "media", mediaType: "image" } });
        const settled = await ctx.settled(operationId);
        const image = inbound(settled, { channel: "WHATSAPP" }).find((message) => message.attachments.some((attachment) => attachment.status === "REJECTED"));
        ctx.check(image !== undefined, "the image is recorded as rejected media");
        ctx.exactly(settled, before, "document versions (no intake for an image)", settled.versions);
        ctx.check(outbound(settled, { channel: "WHATSAPP", author: "SYSTEM", status: [...SENT_STATUSES] }).length > 0, "the fixed answer went out");
      },
    },
  ],
});
