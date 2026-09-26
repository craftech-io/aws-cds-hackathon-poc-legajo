// SC-04 · wrong and unknown documents (docs/test-plan.md §4.5): op-4476 (supplier in Europe/Istanbul,
// `WRONG_DOC`) from Monday 19/10 09:58, and op-4477 (supplier in Asia/Seoul, `UNKNOWN_DOC`) from Tuesday
// 20/10 09:58, each in its own world. The reader decides the type of every PDF, never the subject or
// the file name; what it does not recognize goes to the broker, who classifies it.
import { SENT_STATUSES, document, openEscalations, outbound } from "./lib/asserts";
import { supplierReplies, upToSupplierEmail } from "./lib/flows";
import { defineScenario, ensure } from "./lib/steps";
import { awaitState, createWorld, opOf } from "./lib/world";

const ISTANBUL = { start: "2026-10-19T09:58:00-03:00", eta: "2026-10-26T10:00:00-03:00", docsRequest: "2026-10-19T10:00:00-03:00" };
const SEOUL = { start: "2026-10-20T09:58:00-03:00", eta: "2026-10-27T10:00:00-03:00", docsRequest: "2026-10-20T10:00:00-03:00", morning: "2026-10-20T21:00:00-03:00" };

export const sc04 = defineScenario({
  id: "SC-04",
  slug: "sc04",
  title: "Wrong and unrecognized documents",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the request to Istanbul goes at 19/10 10:0x (16:0x there), not deferred",
      flows: ["FL-025"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: ISTANBUL.start, operations: [{ key: "a", model: "op-4476", etaOverride: ISTANBUL.eta, authorizations: true }] });
        const { operationId } = opOf(ctx);
        await ctx.qa("supplier.setBehaviour", { operationId, behaviour: "WRONG_DOC" });
        await upToSupplierEmail(ctx, operationId, ISTANBUL.docsRequest);
      },
    },
    {
      n: 2,
      title: "the reply brings another document of the file instead of the one asked for",
      flows: ["FL-025"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const read = await supplierReplies(ctx, operationId, (snapshot) => snapshot.versions.length > 0, "a version read");
        ctx.check(document(read, "CERTIFICATE_OF_ORIGIN").status === "MISSING", "the certificate is still MISSING");
        ctx.check(read.versions.every((version) => version.docType !== "CERTIFICATE_OF_ORIGIN" || version.reading?.status !== "RECOGNIZED"), "the version is filed under the type the reader found");
      },
    },
    {
      n: 3,
      title: "the certificate is asked for again",
      flows: ["FL-025"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const again = await awaitState(ctx, operationId, "a new request for the certificate", (snapshot) => outbound(snapshot, { channel: "EMAIL", status: [...SENT_STATUSES] }).filter((message) => message.refs.docTypes?.includes("CERTIFICATE_OF_ORIGIN")).length >= 2);
        ctx.check(outbound(again, { channel: "EMAIL" }).length >= 2, "a second email to the supplier");
      },
    },
    {
      n: 4,
      title: "op-4477: the email waits for 09:00 in Seoul (20/10 21:00 AR); the reply brings a PDF the reader does not know",
      flows: ["FL-026"],
      async run(ctx) {
        await createWorld(ctx, { suffix: "b", startAtSim: SEOUL.start, operations: [{ key: "a", model: "op-4477", etaOverride: SEOUL.eta, authorizations: true }] });
        const { operationId } = opOf(ctx, "a", "b");
        await ctx.qa("supplier.setBehaviour", { operationId, behaviour: "UNKNOWN_DOC" });
        await upToSupplierEmail(ctx, operationId, SEOUL.docsRequest, SEOUL.morning);
        const read = await supplierReplies(ctx, operationId, (snapshot) => snapshot.versions.some((version) => version.reading?.status === "UNRECOGNIZED"), "an UNRECOGNIZED version");
        ctx.check(read.documents.every((row) => row.status === "MISSING"), "no document changes status for an unknown PDF");
      },
    },
    {
      n: 5,
      title: "the unknown document is escalated to the broker",
      flows: ["FL-026"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a", "b");
        const snapshot = await awaitState(ctx, operationId, "UNRECOGNIZED_DOCUMENT escalation", (fresh) => openEscalations(fresh, "UNRECOGNIZED_DOCUMENT").length === 1);
        ctx.state.unknownVersion = snapshot.versions.find((version) => version.reading?.status === "UNRECOGNIZED")?.docVersionId;
      },
    },
    {
      n: 6,
      title: "the broker classifies it from the console",
      flows: ["FL-044"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a", "b");
        const docVersionId = ctx.state.unknownVersion;
        ensure(typeof docVersionId === "string", "step 5 found the unrecognized version");
        await ctx.qa("console", { procedure: "dossier.classifyDocument", input: { docVersionId, docType: "CERTIFICATE_OF_ORIGIN" } });
        const classified = await ctx.settled(operationId);
        const version = classified.versions.find((row) => row.docVersionId === docVersionId);
        ctx.check(version?.classifiedBy === "BROKER:brk-qa-runner", "the version records who classified it");
        ctx.none(classified, "open UNRECOGNIZED_DOCUMENT escalations", openEscalations(classified, "UNRECOGNIZED_DOCUMENT"));
      },
    },
  ],
});
