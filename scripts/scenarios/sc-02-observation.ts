// SC-02 · observation (docs/test-plan.md §4.5): op-4471 with a `SEEDED_ERROR` supplier, as SC-01 up to
// the email to Qingdao at 15/10 22:00. The reply at 22:10 brings a packing list whose gross weight does
// not match; the correction goes back in the thread (09:10 in Qingdao) and the importer's notice waits
// for 16/10 09:00; the second reply at 22:20 brings v2.
import { SENT_STATUSES, decisions, document, observations, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { supplierReplies, upToSupplierEmail } from "./lib/flows";
import { defineScenario, ensure } from "./lib/steps";
import { advanceTo, awaitState, createWorld, opOf } from "./lib/world";

const START = "2026-10-15T09:55:00-03:00";
const DOCS_REQUEST = "2026-10-15T10:00:00-03:00";
const QINGDAO_MORNING = "2026-10-15T22:00:00-03:00";
const AR_MORNING = "2026-10-16T09:00:00-03:00";

export const sc02 = defineScenario({
  id: "SC-02",
  slug: "sc02",
  title: "Observation corrected by the supplier",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world, behaviour SEEDED_ERROR, request and email to Qingdao at 22:00",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4471", authorizations: true }] });
        const { operationId } = opOf(ctx);
        await ctx.qa("supplier.setBehaviour", { operationId, behaviour: "SEEDED_ERROR" });
        await upToSupplierEmail(ctx, operationId, DOCS_REQUEST, QINGDAO_MORNING);
      },
    },
    {
      n: 1,
      title: "22:10: the simulated supplier replies as configured, the packing list reads GROSS_WEIGHT_MISMATCH",
      flows: ["FL-022", "FL-088"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const read = await supplierReplies(ctx, operationId, (snapshot) => observations(snapshot, { code: "GROSS_WEIGHT_MISMATCH" }).length > 0, "the packing list with its observation");
        ctx.check(read.operation.simBehaviour === "SEEDED_ERROR", "the operation carries the behaviour the scenario set");
        ctx.check(document(read, "PACKING_LIST").status === "WITH_OBSERVATION", "the packing list is WITH_OBSERVATION");
      },
    },
    {
      n: 2,
      title: "the correction goes to the supplier in the thread",
      flows: ["FL-022"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const snapshot = await awaitState(ctx, operationId, "CORRECTION_REQUEST sent", (fresh) => outbound(fresh, { channel: "EMAIL", kind: "CORRECTION_REQUEST", status: [...SENT_STATUSES] }).length > 0, WAITS.sesRoundTripSec);
        const observation = observations(snapshot, { code: "GROSS_WEIGHT_MISMATCH" })[0];
        ensure(observation !== undefined, "the observation exists");
        const correction = outbound(snapshot, { channel: "EMAIL", kind: "CORRECTION_REQUEST" })[0];
        ctx.check(correction?.refs.observationIds?.includes(observation.observationId), "the correction names the observation");
        ctx.check(correction?.inReplyTo !== undefined, "the correction goes in the thread (In-Reply-To)");
        ctx.check(observation.status === "CORRECTION_REQUESTED" && observation.attempts === 1 && observation.matchesMatrix === true, "the observation asks the supplier, first attempt, as the matrix says");
      },
    },
    {
      n: 3,
      title: "“No tenés que hacer nada” to the importer waits for 16/10 09:00",
      flows: ["FL-022"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const snapshot = await awaitState(ctx, operationId, "the notice to the importer deferred", (fresh) => decisions(fresh, { decision: "DEFER", ruleId: "CP-HOURS-AR" }).length > 0);
        ctx.check(snapshot.pendingTimers.some((timer) => timer.kind === "DEFERRED_SEND" && Date.parse(timer.dueAtSim) === Date.parse(AR_MORNING)), "the notice is due at 16/10 09:00");
      },
    },
    {
      n: 4,
      title: "22:20: the supplier's second reply brings version 2",
      flows: ["FL-023"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await supplierReplies(ctx, operationId, (snapshot) => document(snapshot, "PACKING_LIST").currentVersion >= 2, "packing list v2");
      },
    },
    {
      n: 5,
      title: "v2 is valid; at 16/10 09:00 both WhatsApp messages go out",
      flows: ["FL-023"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const valid = await awaitState(ctx, operationId, "packing list VALID", (snapshot) => document(snapshot, "PACKING_LIST").status === "VALID");
        ctx.check(observations(valid, { code: "GROSS_WEIGHT_MISMATCH" }).every((row) => row.status === "RESOLVED"), "the observation is resolved with the new version");
        await advanceTo(ctx, operationId, AR_MORNING);
        const morning = await ctx.settled(operationId);
        const toImporter = outbound(morning, { channel: "WHATSAPP", counterpart: "IMPORTER", status: [...SENT_STATUSES], sinceSim: AR_MORNING });
        ctx.exactly(morning, 2, "WhatsApp messages to the importer at 16/10 09:00", toImporter);
      },
    },
  ],
});
