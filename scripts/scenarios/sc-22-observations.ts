// SC-22 · observations and their responsible party (docs/test-plan.md §4.5): clones of op-4484 (the
// buyer's data: the importer confirms first), op-4485 (an illegible copy: back to whoever sent it) and
// op-4486 (a certificate without signature), Thursday 15/10 10:30, ETA far enough that no milestone
// fires. The supplier sends the template PDFs (version 1, the one with the seeded observation) on demand;
// the broker waives the last observation from the console.
import { SENT_STATUSES, decisions, observations, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { importerSays } from "./lib/flows";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { awaitState, createWorld, opOf, worldOf } from "./lib/world";

const START = "2026-10-15T10:30:00-03:00";
const ETA = "2026-10-28T10:00:00-03:00";

/** The supplier's mail with the three template PDFs of version 1, read by the reader. */
async function documentsArrive(ctx: ScenarioContext, key: string, code: string) {
  const { operationId } = opOf(ctx, key);
  const { mailId } = (await ctx.qa("supplier.sendNow", { operationId, docTypes: ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"], version: 1 })) as { mailId: string };
  const outcome = (await ctx.qa("mail.outcome", { clockId: worldOf(ctx).clockId, mailId, timeoutSec: WAITS.sesRoundTripSec })) as { outcome: string };
  ctx.check(outcome.outcome === "ENQUEUED", `the supplier's mail was ${outcome.outcome}`);
  return awaitState(ctx, operationId, `observation ${code}`, (snapshot) => observations(snapshot, { code }).length === 1, WAITS.sesRoundTripSec);
}

export const sc22 = defineScenario({
  id: "SC-22",
  slug: "sc22",
  title: "Observations and responsibility",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "the buyer's data does not match: the importer is asked first, as the matrix says",
      flows: ["FL-039"],
      async run(ctx) {
        const base = { etaOverride: ETA, authorizations: true };
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4484", ...base }, { key: "b", model: "op-4485", ...base }, { key: "c", model: "op-4486", ...base }] });
        const read = await documentsArrive(ctx, "a", "BUYER_DATA_MISMATCH");
        const observation = observations(read, { code: "BUYER_DATA_MISMATCH" })[0];
        ctx.check(observation?.responsibleParty === "IMPORTER" && observation.matchesMatrix === true, "responsible IMPORTER, as the matrix says");
        await awaitState(ctx, opOf(ctx, "a").operationId, "the question to the importer", (snapshot) => outbound(snapshot, { channel: "WHATSAPP", counterpart: "IMPORTER", status: [...SENT_STATUSES] }).some((message) => message.refs.observationIds?.includes(observation?.observationId ?? "") === true));
      },
    },
    {
      n: 2,
      title: "the importer confirms their data: the supplier has to correct",
      flows: ["FL-039"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "a");
        await importerSays(ctx, operationId, "Sí, los datos del comprador que tienen ustedes son los correctos.");
        await awaitState(ctx, operationId, "responsible SUPPLIER", (snapshot) => observations(snapshot, { code: "BUYER_DATA_MISMATCH" }).some((row) => row.responsibleParty === "SUPPLIER" && row.matchesMatrix === true));
      },
    },
    {
      n: 3,
      title: "the correction goes to the supplier",
      flows: ["FL-039"],
      async run(ctx) {
        await awaitState(ctx, opOf(ctx, "a").operationId, "CORRECTION_REQUEST", (snapshot) => outbound(snapshot, { channel: "EMAIL", kind: "CORRECTION_REQUEST", status: [...SENT_STATUSES] }).length === 1, WAITS.sesRoundTripSec);
      },
    },
    {
      n: 4,
      title: "an illegible copy is observed as LOW_CONFIDENCE",
      flows: ["FL-040"],
      async run(ctx) {
        await documentsArrive(ctx, "b", "LOW_CONFIDENCE");
      },
    },
    {
      n: 5,
      title: "the new copy is asked of whoever sent it",
      flows: ["FL-040"],
      async run(ctx) {
        const asked = await awaitState(ctx, opOf(ctx, "b").operationId, "the request to the sender", (snapshot) => outbound(snapshot, { channel: "EMAIL", kind: "CORRECTION_REQUEST", status: [...SENT_STATUSES] }).length === 1, WAITS.sesRoundTripSec);
        ctx.check(observations(asked, { code: "LOW_CONFIDENCE" })[0]?.responsibleParty === "SUPPLIER", "the sender (the supplier) corrects it");
      },
    },
    {
      n: 6,
      title: "a certificate without signature is corrected by the supplier",
      flows: ["FL-041"],
      async run(ctx) {
        await documentsArrive(ctx, "c", "MISSING_SIGNATURE");
        const asked = await awaitState(ctx, opOf(ctx, "c").operationId, "CORRECTION_REQUEST", (snapshot) => outbound(snapshot, { channel: "EMAIL", kind: "CORRECTION_REQUEST", status: [...SENT_STATUSES] }).length === 1, WAITS.sesRoundTripSec);
        ctx.check(observations(asked, { code: "MISSING_SIGNATURE" })[0]?.status === "CORRECTION_REQUESTED", "the observation asks for the correction");
      },
    },
    {
      n: 7,
      title: "the broker waives the observation from the console",
      flows: ["FL-043"],
      async run(ctx) {
        const { operationId } = opOf(ctx, "c");
        const observation = observations(await ctx.settled(operationId), { code: "MISSING_SIGNATURE" })[0];
        ensure(observation !== undefined, "the observation to waive");
        await ctx.qa("console", { procedure: "dossier.waiveObservation", input: { observationId: observation.observationId, reason: "El certificado firmado ya fue presentado en papel." } });
        const waived = await ctx.settled(operationId);
        ctx.check(observations(waived, { code: "MISSING_SIGNATURE" })[0]?.status === "WAIVED_BY_BROKER", "the observation is waived");
        ctx.check(decisions(waived, { action: "WAIVED" }).some((row) => row.refs.brokerId === "brk-qa-runner"), "WAIVED is audited with the broker");
      },
    },
  ],
});
