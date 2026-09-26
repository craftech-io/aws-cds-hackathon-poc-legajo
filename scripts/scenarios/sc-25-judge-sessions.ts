// SC-25 · the judge's world and its sessions (docs/test-plan.md §4.5): two browser contexts (A and B)
// of the synthetic account `judge-test` on the deployed console. The first sign-in creates the judge's
// world from the `judge` template through the BFF; a second session gets the shell's fixed notice
// without a reset button; "Reiniciar demo" brings the template back, with a new epoch, a new thread
// address for 4471 and the platform's ETA restored. Runs before SC-24 (the same account) and destroys
// the judge world at the start and in its cleanup.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { QaSnapshot } from "@legajo/bff/qa-driver/snapshot";
import { JUDGE_TEST_CLOCK_ID } from "@legajo/shared";
import { clockCopy } from "../../packages/web/src/views/clock/copy";
import { TOUR_WINDOW } from "../../packages/web/src/views/tour/steps";
import { judgePassword, launchBrowser, operationIdOf, otherSessionNotice, signIn } from "./lib/browser";
import { SITE } from "./lib/site";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";

const TEMPLATE_ETA = "2026-10-22T08:00:00-03:00";
const EARLIER_ETA = "2026-10-20T08:00:00-03:00";

interface Sessions {
  readonly browser: Browser;
  readonly contexts: BrowserContext[];
  readonly password: string;
  a?: Page;
  b?: Page;
}

function sessionsOf(ctx: ScenarioContext): Sessions {
  const sessions = ctx.state.sessions as Sessions | undefined;
  ensure(sessions !== undefined, "the browser is open (step 1)");
  return sessions;
}

async function newSession(sessions: Sessions): Promise<Page> {
  const context = await sessions.browser.newContext();
  sessions.contexts.push(context);
  const page = await context.newPage();
  await signIn(page, sessions.password);
  return page;
}

async function platformEta(ctx: ScenarioContext): Promise<number> {
  const row = (await ctx.qa("platform.get", { firmId: "firm-judge-test", operationNumber: "4471" })) as { eta: string };
  return Date.parse(row.eta);
}

const section = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });

export const sc25 = defineScenario({
  id: "SC-25",
  slug: "sc25",
  title: "The judge's world and its sessions",
  suites: ["full"],
  lane: "judge",
  steps: [
    {
      n: 1,
      title: "the first sign-in creates the judge's world from its template, paused at 14/10 10:30",
      flows: ["FL-079"],
      async run(ctx) {
        await ctx.qa("world.destroy", { clockId: JUDGE_TEST_CLOCK_ID });
        const sessions: Sessions = { browser: await launchBrowser(), contexts: [], password: judgePassword() };
        ctx.state.sessions = sessions;
        sessions.a = await newSession(sessions);
        const operationId = await operationIdOf(sessions.a, "4471");
        ctx.state.operationId = operationId;
        const snapshot = (await ctx.qa("snapshot", { operationId })) as QaSnapshot;
        ctx.check(snapshot.clock.mode === "PAUSED" && Date.parse(snapshot.clock.simNow) === Date.parse(TOUR_WINDOW.startSim), "the world is paused at 14/10 10:30");
        ctx.check((await platformEta(ctx)) === Date.parse(TEMPLATE_ETA), "the platform has 4471 with its ETA of the template");
        ctx.state.before = { threadAddress: snapshot.operation.threadAddress, worldEpoch: snapshot.clock.worldEpoch };
      },
    },
    {
      n: 2,
      title: "session A moves the ETA of 4471 two days earlier",
      flows: ["FL-079"],
      async run(ctx) {
        const page = sessionsOf(ctx).a;
        ensure(page !== undefined, "session A is open");
        await page.goto(`${SITE}/app/clock`);
        const operation = section(page, clockCopy.operation.title);
        await operation.getByRole("button", { name: clockCopy.operation.etaEarlier }).click();
        await operation.getByRole("button", { name: clockCopy.operation.etaSubmit }).click();
        await ctx.eventually("the platform with the earlier ETA", async () => (await platformEta(ctx)) === Date.parse(EARLIER_ETA), 60);
      },
    },
    {
      n: 3,
      title: "session B is told that another session used the world, and gets no reset button there",
      flows: ["FL-079"],
      async run(ctx) {
        const sessions = sessionsOf(ctx);
        sessions.b = await newSession(sessions);
        const notice = otherSessionNotice(sessions.b);
        await expect(notice).toBeVisible({ timeout: 60_000 });
        await expect(notice.getByRole("button")).toHaveCount(0);
      },
    },
    {
      n: 4,
      title: "session A resets the demo: the template again, a new epoch and a new address for 4471",
      flows: ["FL-087"],
      async run(ctx) {
        const page = sessionsOf(ctx).a;
        ensure(page !== undefined, "session A is open");
        await page.goto(`${SITE}/app/clock`);
        const reset = section(page, clockCopy.reset.title);
        await reset.getByRole("button", { name: clockCopy.reset.open }).click();
        await reset.getByRole("button", { name: clockCopy.reset.confirm }).click();
        const before = ctx.state.before as { threadAddress: string; worldEpoch: number };
        const after = await ctx.eventually("the world reloaded with a new epoch", async () => {
          const operationId = await operationIdOf(page, "4471");
          const snapshot = (await ctx.qa("snapshot", { operationId })) as QaSnapshot;
          return snapshot.clock.worldEpoch === before.worldEpoch + 1 ? snapshot : undefined;
        }, 120);
        ctx.check(after.operation.threadAddress !== before.threadAddress, "4471 has another thread address");
        ctx.check(Date.parse(after.clock.simNow) === Date.parse(TOUR_WINDOW.startSim) && after.clock.mode === "PAUSED", "the clock is back at the template's start, paused");
      },
    },
    {
      n: 5,
      title: "the platform has 4471 with the template's ETA again",
      flows: ["FL-087"],
      async run(ctx) {
        ctx.check((await platformEta(ctx)) === Date.parse(TEMPLATE_ETA), "the reset restored the platform's ETA");
      },
    },
  ],
  async cleanup(ctx) {
    const sessions = ctx.state.sessions as Sessions | undefined;
    for (const context of sessions?.contexts ?? []) await context.close();
    await sessions?.browser.close();
    await ctx.qa("world.destroy", { clockId: JUDGE_TEST_CLOCK_ID });
  },
});
