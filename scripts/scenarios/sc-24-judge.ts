// SC-24 · the judge's guided tour on the deployed console (docs/test-plan.md §4.5, docs/design-brief.md
// §15): Playwright against https://legajo.demo.craftech.io with the synthetic account `judge-test`,
// walking TOUR_STEPS of packages/web/src/views/tour/steps.ts literally (the same source as the README
// and the console's panel; `npm run tour:check` holds the three together). Every button is touched the
// moment it is enabled; only then the state the step describes is asserted, within the step's wait.
// The driver only destroys and reads `JUDGE#firm-judge-test` (ADR-0005); runs after SC-25, never with it.
import type { Browser, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { QaSnapshot } from "@legajo/bff/qa-driver/snapshot";
import { BUTTON_LABELS } from "@legajo/bff/copy/buttons";
import { JUDGE_TEST_CLOCK_ID } from "@legajo/shared";
import { copy } from "../../packages/web/src/copy/console";
import { TOUR_TEXTS } from "../../packages/web/src/views/tour/copy";
import { TOUR_STEPS, TOUR_WINDOW, type TourStep, type TourStepId, lookText } from "../../packages/web/src/views/tour/steps";
import { SENT_STATUSES, allValid, observations, outbound } from "./lib/asserts";
import { accountApiRefuses, judgePassword, launchBrowser, moveButton, operationIdOf, phoneButton, signIn, tapWhenEnabled, tokenPlaces, tourPanel, confirmWithPassword } from "./lib/browser";
import { isLanguage } from "./lib/oracles";
import { SITE } from "./lib/site";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";

interface Tour {
  readonly browser: Browser;
  readonly page: Page;
  readonly password: string;
  operationId?: string;
}

function tourOf(ctx: ScenarioContext): Tour {
  const tour = ctx.state.tour as Tour | undefined;
  ensure(tour !== undefined, "the tour's browser is open (step 1)");
  return tour;
}

async function snapshotOf(ctx: ScenarioContext): Promise<QaSnapshot> {
  const { operationId } = tourOf(ctx);
  ensure(operationId !== undefined, "the tour found operation 4471");
  return ctx.snapshot(operationId);
}

/** "Qué mirar" as the panel must show it: each hour from the pending timers of 4471 (what `clock.get` lists). */
function expectedLook(step: TourStep, snapshot: QaSnapshot): string {
  const now = Date.parse(snapshot.clock.simNow);
  return lookText(step, "es", (_name, time) =>
    time.timer === "WORLD_START" ? TOUR_WINDOW.startSim : snapshot.pendingTimers.filter((timer) => timer.kind === time.timer && Date.parse(timer.dueAtSim) >= now).sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim))[0]?.dueAtSim,
  );
}

async function until(ctx: ScenarioContext, step: TourStep, what: string, probe: (snapshot: QaSnapshot) => boolean): Promise<QaSnapshot> {
  return ctx.eventually(what, async () => {
    const snapshot = await snapshotOf(ctx);
    return probe(snapshot) ? snapshot : undefined;
  }, Math.max(step.waitSec, 60));
}

type Check = (ctx: ScenarioContext, tour: Tour, step: TourStep) => Promise<void>;

/** What each step asserts after its buttons, and the flows it proves. */
const CHECKS: Readonly<Record<TourStepId, { readonly flows: readonly string[]; readonly check: Check }>> = {
  "sign-in": {
    flows: ["FL-079"],
    async check(ctx, tour) {
      const places = await tokenPlaces(tour.page);
      ctx.check(places.session !== undefined, "the session tokens are in sessionStorage");
      ctx.check(places.localStorageKeys.every((key) => !/token/i.test(key)), "no token in localStorage");
      ctx.check(await accountApiRefuses(places.session?.accessToken ?? ""), "Cognito's account API refuses the judge's access token (no aws.cognito.signin.user.admin)");
      tour.operationId = await operationIdOf(tour.page, "4471");
      const snapshot = await snapshotOf(ctx);
      ctx.check(snapshot.clock.mode === "PAUSED" && Date.parse(snapshot.clock.simNow) === Date.parse(TOUR_WINDOW.startSim), "the judge's own world is paused at 14/10 10:30");
    },
  },
  "first-request": {
    flows: [],
    async check(ctx, _tour, step) {
      await until(ctx, step, "the template of the first request", (snapshot) => outbound(snapshot, { kind: "DOCS_REQUEST", status: [...SENT_STATUSES] }).length > 0);
    },
  },
  delegate: {
    flows: ["FL-083"],
    async check(ctx, tour, step) {
      await tapWhenEnabled(phoneButton(tour.page, BUTTON_LABELS.SUPPLIER_SENDS.template), step.waitSec);
      await tapWhenEnabled(phoneButton(tour.page, BUTTON_LABELS.CONFIRM_CONTACT.template), step.waitSec);
      await until(ctx, step, "the email deferred to 15/10 22:00", (snapshot) => snapshot.pendingTimers.some((timer) => timer.kind === "DEFERRED_SEND" && Date.parse(timer.dueAtSim) === Date.parse("2026-10-15T22:00:00-03:00")));
    },
  },
  email: {
    flows: ["FL-065", "FL-084"],
    async check(ctx, tour, step) {
      const sent = await until(ctx, step, "the email to the supplier sent", (snapshot) => outbound(snapshot, { channel: "EMAIL", status: [...SENT_STATUSES] }).length > 0);
      ctx.check(isLanguage(outbound(sent, { channel: "EMAIL" })[0]?.body ?? "", "en"), "the email is in English");
      await tour.page.goto(`${SITE}/app/mailbox`);
      await expect(tour.page.getByText(/\[Op 4471\]/).first()).toBeVisible({ timeout: step.waitSec * 1_000 });
    },
  },
  reply: {
    flows: [],
    async check(ctx, _tour, step) {
      await until(ctx, step, "the reading with GROSS_WEIGHT_MISMATCH and its correction", (snapshot) => observations(snapshot, { code: "GROSS_WEIGHT_MISMATCH" }).length > 0 && outbound(snapshot, { kind: "CORRECTION_REQUEST" }).length > 0);
    },
  },
  correction: {
    flows: [],
    async check(ctx, _tour, step) {
      await until(ctx, step, "packing list v2 valid, ready for review and both notices out", (snapshot) => allValid(snapshot) && snapshot.operation.dossierStatus === "READY_FOR_REVIEW" && outbound(snapshot, { channel: "WHATSAPP", sinceSim: TOUR_WINDOW.endSim, status: [...SENT_STATUSES] }).length >= 2);
    },
  },
  eta: {
    flows: [],
    async check(ctx, _tour, step) {
      const moved = await until(ctx, step, "the ETA two days earlier and its notice", (snapshot) => outbound(snapshot, { kind: "ETA_CHANGE" }).length > 0);
      const platform = (await ctx.qa("platform.get", { firmId: "firm-judge-test", operationNumber: "4471" })) as { eta: string };
      ctx.check(Date.parse(platform.eta) === Date.parse(moved.operation.eta), "the platform and the dossier agree on the new ETA");
    },
  },
  approve: {
    flows: ["FL-073"],
    async check(ctx, tour, step) {
      await confirmWithPassword(tour.page, tour.password);
      await until(ctx, step, "approved, with the notice", (snapshot) => snapshot.operation.dossierStatus === "APPROVED" && outbound(snapshot, { kind: "APPROVAL_NOTICE" }).length > 0);
    },
  },
  dispatch: {
    flows: [],
    async check(ctx, _tour, step) {
      await until(ctx, step, "three dispatch notices", (snapshot) => outbound(snapshot, { kind: "DISPATCH_STATUS" }).length >= 3);
    },
  },
  metrics: {
    flows: [],
    async check(_ctx, tour) {
      await expect(tour.page.getByRole("heading", { level: 1, name: copy.views.metrics.title })).toBeVisible({ timeout: 30_000 });
    },
  },
};

async function runTourStep(ctx: ScenarioContext, step: TourStep): Promise<void> {
  if (step.number === 1) {
    await ctx.qa("world.destroy", { clockId: JUDGE_TEST_CLOCK_ID });
    const password = judgePassword();
    const browser = await launchBrowser();
    ctx.state.tour = { browser, page: await browser.newPage(), password } satisfies Tour;
    await signIn(tourOf(ctx).page, password);
  }
  const tour = tourOf(ctx);
  await expect(tourPanel(tour.page).getByRole("heading", { name: step.title.es })).toBeVisible({ timeout: 60_000 });
  if (tour.operationId !== undefined) await expect(tourPanel(tour.page)).toContainText(expectedLook(step, await snapshotOf(ctx)), { timeout: 60_000 });
  for (const [index, move] of step.moves.entries()) {
    await tapWhenEnabled(moveButton(tour.page, step, index), Math.max(step.waitSec, 30));
    if (move.expect !== undefined) {
      if (step.number >= 4 && step.number <= 6) await expect(tourPanel(tour.page).getByText(TOUR_TEXTS.es.busy)).toBeVisible({ timeout: 60_000 });
      const expected = move.expect;
      await until(ctx, step, `the clock on the ${expected.timer} of 4471 at ${expected.simNow}`, (snapshot) => Date.parse(snapshot.clock.simNow) === Date.parse(expected.simNow));
    }
  }
  await CHECKS[step.id].check(ctx, tour, step);
}

export const sc24 = defineScenario({
  id: "SC-24",
  slug: "sc24",
  title: "The judge's guided tour on the deployed console",
  suites: ["full"],
  lane: "judge",
  steps: TOUR_STEPS.map((step) => ({ n: step.number, title: step.title.en, flows: CHECKS[step.id].flows, run: (ctx: ScenarioContext) => runTourStep(ctx, step) })),
  async cleanup(ctx) {
    const tour = ctx.state.tour as Tour | undefined;
    await tour?.browser.close();
  },
});
