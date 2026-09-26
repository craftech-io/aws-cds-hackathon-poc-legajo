// SC-03 · two failed attempts (docs/test-plan.md §4.5): op-4479 with a `SEEDED_ERROR_TWICE` supplier in
// Asia/Shanghai, Wednesday 21/10 09:58. The email waits for 22:00 AR; v1 comes with an observation at
// 22:10, the correction goes at 22:1x, v2 comes at 22:2x with the same observation: the observation is
// escalated, the firm's mailbox gets it and no third correction is ever sent.
import { SENT_STATUSES, observations, openEscalations, outbound } from "./lib/asserts";
import { WAITS } from "./lib/eventually";
import { supplierReplies, upToSupplierEmail } from "./lib/flows";
import { defineScenario } from "./lib/steps";
import { awaitState, createWorld, opOf } from "./lib/world";

const START = "2026-10-21T09:58:00-03:00";
const DOCS_REQUEST = "2026-10-21T10:00:00-03:00";
const SHANGHAI_MORNING = "2026-10-21T22:00:00-03:00";

export const sc03 = defineScenario({
  id: "SC-03",
  slug: "sc03",
  title: "Second failed attempt escalates",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "request at 21/10 10:00, email at 22:00 AR, v1 with an observation at 22:10",
      flows: ["FL-024"],
      async run(ctx) {
        await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4479", authorizations: true }] });
        const { operationId } = opOf(ctx);
        await ctx.qa("supplier.setBehaviour", { operationId, behaviour: "SEEDED_ERROR_TWICE" });
        await upToSupplierEmail(ctx, operationId, DOCS_REQUEST, SHANGHAI_MORNING);
        await supplierReplies(ctx, operationId, (snapshot) => observations(snapshot).length > 0, "v1 with an observation");
      },
    },
    {
      n: 2,
      title: "the correction goes at 22:1x",
      flows: ["FL-024"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const snapshot = await awaitState(ctx, operationId, "first CORRECTION_REQUEST", (fresh) => outbound(fresh, { kind: "CORRECTION_REQUEST", status: [...SENT_STATUSES] }).length === 1, WAITS.sesRoundTripSec);
        ctx.check(observations(snapshot).some((row) => row.status === "CORRECTION_REQUESTED" && row.attempts === 1), "first attempt counted");
      },
    },
    {
      n: 3,
      title: "22:2x: v2 comes with the same observation and it is escalated",
      flows: ["FL-024"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const escalated = await supplierReplies(ctx, operationId, (snapshot) => observations(snapshot).some((row) => row.status === "ESCALATED"), "the observation ESCALATED");
        ctx.check(openEscalations(escalated).length === 1, "one escalation is open");
      },
    },
    {
      n: 4,
      title: "settled: the firm's mailbox has the escalation and no third correction exists",
      flows: ["FL-024"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await awaitState(ctx, operationId, "the escalation in the firm's mailbox", (snapshot) => snapshot.mailbox.length > 0, WAITS.sesRoundTripSec);
        const settled = await ctx.settled(operationId);
        ctx.exactly(settled, 1, "CORRECTION_REQUEST emails", outbound(settled, { kind: "CORRECTION_REQUEST" }));
      },
    },
  ],
});
