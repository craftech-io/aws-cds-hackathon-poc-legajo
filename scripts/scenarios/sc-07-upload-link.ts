// SC-07 · upload link (docs/test-plan.md §4.5): two clones of op-4471 (Thursday 15/10 09:58), each
// with its own importer. The driver acts as the importer's browser on `/u/<token>` through the public
// site: a real presigned POST, the real malware scan of `Uploads`, `DocumentIntake` and the reader.
// Clone `b` proves the expired link; clone `a` the accepted PDF and the refused files.
import { SENT_STATUSES, decisions, document, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { firstRequest } from "./lib/flows";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { awaitState, createWorld, opOf } from "./lib/world";

const START = "2026-10-15T09:58:00-03:00";
const DOCS_REQUEST = "2026-10-15T10:00:00-03:00";

interface Upload {
  readonly status: number;
  readonly refusal?: string;
  readonly key?: string;
  readonly storageStatus?: number;
}

async function presign(ctx: ScenarioContext, operationId: string, file: { kind: "pdf" | "notPdf" | "oversize"; docType: "CERTIFICATE_OF_ORIGIN" | "PACKING_LIST" }): Promise<Upload> {
  return (await ctx.qa("upload.presign", { operationId, file })) as Upload;
}

/** A refused file leaves no version behind, and its refusal is audited once. */
async function refused(ctx: ScenarioContext, operationId: string, upload: Upload, status: number, refusal: string, denial: string): Promise<void> {
  ctx.check(upload.status === status && upload.refusal === refusal, `the page answered ${upload.status} ${upload.refusal ?? ""}, expected ${status} ${refusal}`);
  const settled = await ctx.settled(operationId);
  ctx.exactly(settled, 1, `DENY ${denial}`, decisions(settled, { decision: "DENY", action: denial }));
  ctx.none(settled, "new versions of the packing list", settled.versions.filter((version) => version.docType === "PACKING_LIST"));
}

export const sc07 = defineScenario({
  id: "SC-07",
  slug: "sc07",
  title: "Upload link",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the pending-documents template carries the upload link",
      flows: ["FL-009"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4471" }, { key: "b", model: "op-4471" }] });
        const request = await firstRequest(ctx, opOf(ctx, "a").operationId, DOCS_REQUEST);
        const link = outbound(request, { kind: "DOCS_REQUEST" })[0]?.buttons.find((button) => button.action === "UPLOAD");
        ctx.check(link?.url?.startsWith("https://legajo.demo.craftech.io/u/") === true, "the UPLOAD button opens /u/<token>");
      },
    },
    {
      n: 2,
      title: "the importer uploads the certificate of origin; the object passes the malware scan",
      flows: ["FL-009"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        const upload = await presign(ctx, operationId, { kind: "pdf", docType: "CERTIFICATE_OF_ORIGIN" });
        ctx.check(upload.status === 200 && upload.storageStatus !== undefined && upload.storageStatus < 300, `the presigned POST was accepted (${upload.storageStatus ?? upload.status})`);
        ensure(upload.key !== undefined, "the page issued an object key");
        const done = (await ctx.qa("upload.done", { operationId, keys: [upload.key] })) as Upload;
        ctx.check(done.status === 200, `"Listo" answered ${done.status}`);
      },
    },
    {
      n: 3,
      title: "the certificate is valid and the importer gets the answer",
      flows: ["FL-009"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        const valid = await awaitState(ctx, operationId, "certificate VALID from the link", (snapshot) => document(snapshot, "CERTIFICATE_OF_ORIGIN").status === "VALID", WAITS.sesRoundTripSec);
        ctx.check(valid.versions.some((version) => version.docType === "CERTIFICATE_OF_ORIGIN" && version.source.channel === "UPLOAD_LINK"), "the version came from the upload link");
        ctx.check(decisions(valid, { action: "UPLOAD_PRESIGNED" }).length > 0, "the link's use is audited");
        await awaitState(ctx, operationId, "the answer to the importer", (snapshot) => outbound(snapshot, { channel: "WHATSAPP", kind: "REPLY", status: [...SENT_STATUSES] }).length > 0);
      },
    },
    {
      n: 4,
      title: "an expired link opens nothing",
      flows: ["FL-010"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "b");
        await ctx.qa("link.expire", { operationId });
        const upload = await presign(ctx, operationId, { kind: "pdf", docType: "PACKING_LIST" });
        ctx.check(upload.status === 410 && upload.key === undefined, `the expired link answered ${upload.status}`);
        const settled = await ctx.settled(operationId);
        ctx.none(settled, "versions of the second clone", settled.versions);
        ctx.exactly(settled, 1, "DENY UPLOAD_LINK_EXPIRED", decisions(settled, { decision: "DENY", action: "UPLOAD_LINK_EXPIRED" }));
      },
    },
    {
      n: 5,
      title: "a file that is not a PDF is refused",
      flows: ["FL-010"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        await refused(ctx, operationId, await presign(ctx, operationId, { kind: "notPdf", docType: "PACKING_LIST" }), 415, "NOT_PDF", "UPLOAD_NOT_PDF");
      },
    },
    {
      n: 6,
      title: "a file over 10 MB is refused",
      flows: ["FL-010"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        await refused(ctx, operationId, await presign(ctx, operationId, { kind: "oversize", docType: "PACKING_LIST" }), 413, "TOO_LARGE", "UPLOAD_TOO_LARGE");
      },
    },
  ],
});
