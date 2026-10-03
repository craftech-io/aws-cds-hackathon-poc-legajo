// SC-00 · smoke of every deploy (docs/test-plan.md §4.5 and §5; SMK/1-6). A clone of op-4472 whose
// supplier is in Europe/Berlin (`PROMPT`), so no email is deferred; Friday 16/10 09:58. The DKIM of a
// first deploy may still be PENDING: with `--allow-dkim-pending` (deploy.yml) a round trip through SES
// that does not complete is a WARN of step 5 instead of a failure.
import { SENT_STATUSES, allValid, milestone, outbound } from "./lib/asserts";
import { WAITS, WaitTimeout } from "./lib/eventually";
import { checkSupplierEmail, delegateToSupplier, expectTemplateRequest } from "./lib/flows";
import { cognitoAllowed, fetchPage, healthOf, landingProblems } from "./lib/site";
import { defineScenario } from "./lib/steps";
import { advanceToTimer, awaitState, createWorld, opOf, schedulerProbe, worldOf } from "./lib/world";

const START = "2026-10-16T09:58:00-03:00";
const DOCS_REQUEST = "2026-10-16T10:00:00-03:00";
/** ETA of the clone: its first milestone falls at 16/10 10:00 AR. */
const ETA = "2026-10-23T10:00:00-03:00";

/** Set by the runner from `--allow-dkim-pending` (a first deploy whose DKIM is not verified yet). */
export const SMOKE_OPTIONS = { allowDkimPending: false };

export const sc00 = defineScenario({
  id: "SC-00",
  slug: "sc00",
  title: "Smoke of the deployed stage",
  suites: ["smoke", "full"],
  steps: [
    {
      n: 1,
      title: "landing and legal pages answer 200 with the security headers",
      flows: ["FL-089"],
      async run(ctx) {
        const landing = await fetchPage("/");
        const problems = landingProblems(landing);
        ctx.check(problems.length === 0, problems.join("; "));
        for (const path of ["/legal/privacy.html", "/legal/terms.html"]) {
          const page = await fetchPage(path);
          ctx.check(page.status === 200 && (page.headers["content-type"] ?? "").includes("text/html"), `GET ${path} answered ${page.status}`);
        }
      },
    },
    {
      n: 2,
      title: "the console's sign-in page is served and may reach Cognito",
      flows: ["FL-079"],
      async run(ctx) {
        const login = await fetchPage("/login");
        ctx.check(login.status === 200 && login.body.includes('<div id="root"'), `GET /login answered ${login.status}`);
        ctx.check(cognitoAllowed(login), "the console's CSP lets the browser reach cognito-idp (SRP sign-in)");
      },
    },
    {
      n: 3,
      title: "/api/health, both mocks with each invoking role, and a world from the platform",
      flows: ["FL-005"],
      async run(ctx) {
        ctx.check(healthOf(await fetchPage("/api/health")) === "ok", "GET /api/health is not ok");
        const mocks = (await ctx.qa("probe.mocks", {})) as Record<string, string>;
        for (const name of ["reader", "platform", "worker"]) ctx.check(mocks[name] === "ok", `probe.mocks: ${name} is ${mocks[name] ?? "missing"}`);
        const world = await createWorld(ctx, { startAtSim: START, operations: [{ key: "a", model: "op-4472", etaOverride: ETA, authorizations: true, supplierOverride: { behaviour: "PROMPT" } }] });
        const snapshot = await ctx.settled(opOf(ctx).operationId);
        ctx.check(snapshot.operation.clockId === world.clockId && snapshot.clock.mode === "PAUSED", "the world starts paused");
        ctx.check(snapshot.documents.length === 3 && snapshot.documents.every((row) => row.status === "MISSING"), "the dossier starts with three MISSING documents");
        ctx.check(milestone(snapshot, "DOCS_REQUEST")?.dueAtSim !== undefined && snapshot.timers.filter((timer) => timer.kind === "MILESTONE").length === 5, "five milestones are scheduled");
        ctx.none(snapshot, "real schedules in a paused world", snapshot.timers.filter((timer) => timer.scheduleName !== undefined));
      },
    },
    {
      n: 4,
      title: "the real Scheduler fires DOCS_REQUEST at 16/10 10:00 and the template goes out",
      flows: ["FL-007", "FL-065"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        await schedulerProbe(ctx, operationId, DOCS_REQUEST);
        await expectTemplateRequest(ctx, operationId);
      },
    },
    {
      n: 5,
      title: "the supplier is written at 10:0x (15:0x in Berlin), replies through SES and the three documents are valid",
      flows: ["FL-012", "FL-021"],
      async run(ctx) {
        const { operationId } = opOf(ctx);
        const sent = await delegateToSupplier(ctx, operationId);
        ctx.check(outbound(sent, { channel: "EMAIL", kind: "DOCS_REQUEST", status: [...SENT_STATUSES] }).length === 1, "the email to Berlin is not deferred");
        checkSupplierEmail(ctx, sent, "DOCS_REQUEST");
        try {
          await awaitState(ctx, operationId, "the supplier's reply is scheduled", (snapshot) => snapshot.pendingTimers.some((timer) => timer.kind === "SIM_REPLY"), WAITS.sesRoundTripSec);
          await advanceToTimer(ctx, operationId, "SIM_REPLY");
          await awaitState(ctx, operationId, "three documents VALID after the round trip through SES", allValid, WAITS.sesRoundTripSec);
        } catch (error) {
          // Only the SES round trip timing out is the pending DKIM; any other failure fails the step.
          if (!SMOKE_OPTIONS.allowDkimPending || !(error instanceof WaitTimeout)) throw error;
          ctx.warn(`round trip through SES skipped on a first deploy (DKIM may be PENDING): ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
    {
      n: 6,
      title: "policy audit of the world: 0 violations",
      flows: [],
      async run(ctx) {
        const { clockId } = worldOf(ctx);
        const audit = (await ctx.qa("policyAudit.run", { clockId })) as { violations: unknown[] };
        ctx.check(audit.violations.length === 0, `${audit.violations.length} policy violation(s)`);
      },
    },
  ],
});
