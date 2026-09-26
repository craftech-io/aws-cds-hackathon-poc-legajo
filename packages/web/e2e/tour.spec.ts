// The judge's guided tour (docs/design-brief.md §15, views/tour/steps.ts). Against the local UI
// server a judge finds the panel open with step 1, its hour read from the real `clock.get` of its
// world, in Spanish or English, and a second session on the same judge world gets the shell's fixed
// notice from the real `account.session`. Scripted answers then walk the buttons: each waits for a
// quiet world, calls the console's own procedure (`clock.advanceTo` at 15/10 10:00, `clock.moveEta`
// from the ETA of 4471, `dossier.approve`), fills "Qué mirar" from the pending timers of 4471 and
// shows the English gloss of the step's message. Nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import { dataCopy } from "../src/copy/console-data.ts";
import { TOUR_TEXTS } from "../src/views/tour/copy.ts";
import { TOUR_STEPS, type TourStep } from "../src/views/tour/steps.ts";
import { type ApiCall, CLOCK_AT_START, routeApi, shellApi } from "./support/api-route";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { plantSession } from "./support/session";

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

const es = TOUR_TEXTS.es;

function panel(page: Page) {
  return page.getByRole("complementary", { name: copy.tour.title });
}

function stepById(id: TourStep["id"]): TourStep {
  const found = TOUR_STEPS.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

function moveButton(page: Page, id: TourStep["id"], index = 0) {
  return panel(page).getByRole("button", { name: stepById(id).moves[index]?.label.es ?? "", exact: true });
}

test.describe("the guided tour against the real world of a judge", () => {
  test("opens with step 1 and the hour of the world's start, in Spanish or English", async ({ page }) => {
    await plantSession(page, "judge");
    await page.goto("/app/operations");
    await expectView(page, "operations");
    await expect(panel(page).getByRole("heading", { name: stepById("sign-in").title.es })).toBeVisible();
    await expect(panel(page)).toContainText("en pausa el 14/10 10:30");
    await expect(panel(page)).toContainText(stepById("sign-in").wait.es);

    await panel(page).getByRole("button", { name: "EN", exact: true }).click();
    await expect(panel(page).getByRole("heading", { name: stepById("sign-in").title.en })).toBeVisible();
    await expect(panel(page)).toContainText("paused at Oct 14 10:30");
    await panel(page).getByRole("button", { name: "ES", exact: true }).click();

    await panel(page).getByRole("button", { name: stepById("sign-in").moves[0]?.label.es ?? "" }).click();
    await expect(panel(page).getByRole("heading", { name: stepById("first-request").title.es })).toBeVisible();
    await expect(moveButton(page, "first-request")).toBeEnabled();
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  // The shell's first batch carries `clock.get` and `account.session` (twice under React's StrictMode):
  // their writes race on the clock's version, and the notice must survive the race (FL-079).
  test("a second session on the same judge world gets the fixed notice, without a reset", async ({ page, browser }) => {
    await plantSession(page, "judge", { signedInAgo: 3_600 });
    const recorded = page.waitForResponse((response) => response.url().includes("account.session") && response.ok());
    await page.goto("/app/operations");
    await recorded;

    const { baseURL, locale, timezoneId } = test.info().project.use;
    const other = await browser.newContext({ baseURL, locale, timezoneId });
    const second = await other.newPage();
    await plantSession(second, "judge", { signedInAgo: 5 });
    await second.goto("/app/operations");
    const notice = second.getByRole("alert").filter({ hasText: copy.session.otherSessionEn });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/Otra sesión usó este mundo hace/);
    await expect(notice.getByRole("button")).toHaveCount(0);
    await other.close();
  });
});

const OPERATIONS = {
  clockId: "JUDGE#firm-judge-01",
  operations: [
    {
      operationId: "op-4471",
      operationNumber: "4471",
      clockId: "JUDGE#firm-judge-01",
      importerId: "imp-norpampa",
      supplierId: "sup-qingdao",
      importerName: "Norpampa Insumos SRL",
      supplierName: "Qingdao Bluewave Textiles Co., Ltd.",
      vessel: "Austral Aurora",
      carrier: "Austral Line",
      portOfLoading: "Qingdao",
      portOfDischarge: "Buenos Aires",
      eta: "2026-10-22T08:00:00-03:00",
      dossierStatus: "READY_FOR_REVIEW",
      control: "AGENT",
      dispatch: { status: "NONE" },
      openedAtSim: "2026-10-14T10:30:00-03:00",
      documents: [],
      openEscalations: 0,
      processError: false,
    },
  ],
};

const JUDGE_CLOCK = { ...CLOCK_AT_START, clockId: "JUDGE#firm-judge-01", worldEpoch: 1, startAtSim: "2026-10-14T10:30:00-03:00", nextEvents: [] };

/** Progress of the tour stored as if the judge had done every move before `id`. */
async function startAt(page: Page, id: TourStep["id"]): Promise<void> {
  const before = TOUR_STEPS.slice(0, TOUR_STEPS.findIndex((step) => step.id === id)).flatMap((step) => step.moves.map((_, index) => `${step.id}#${index}`));
  await page.addInitScript((done) => window.sessionStorage.setItem("legajo.tour.JUDGE#firm-judge-01#1", JSON.stringify(done)), before);
}

async function scripted(page: Page, world: Record<string, unknown>, overrides: Parameters<typeof shellApi>[0] = {}): Promise<ApiCall[]> {
  const ok = { data: { ok: true } };
  const calls = await routeApi(
    page,
    shellApi({
      "clock.get": { data: world },
      "operations.list": { data: OPERATIONS },
      "clock.advanceTo": { data: world },
      "clock.advanceToNext": { data: world },
      "clock.moveEta": { data: world },
      "dossier.approve": ok,
      "simulator.threads": { data: { threads: [] } },
      ...overrides,
    }),
  );
  await plantSession(page, "judge");
  // The clock view reads only what is scripted here; the panel is the same on every view.
  await page.goto("/app/clock");
  return calls;
}

const inputOf = (calls: readonly ApiCall[], path: string) => calls.find((call) => call.path === path)?.input;

test.describe("the tour's buttons (scripted answers)", () => {
  test("a button that changes the world waits for a quiet one, then goes to the 4471 request at 15/10 10:00", async ({ page }) => {
    await startAt(page, "first-request");
    const calls = await scripted(page, { ...JUDGE_CLOCK, busy: true, pending: [{ kind: "EVENT", operationNumber: "4471", sinceReal: new Date().toISOString() }] });
    await expect(moveButton(page, "first-request")).toBeDisabled();
    await expect(panel(page).getByText(es.busy)).toBeVisible();
    expect(inputOf(calls, "clock.advanceTo")).toBeUndefined();
  });

  test("goes to the 4471 request at 15/10 10:00 and moves on to the next step", async ({ page }) => {
    await startAt(page, "first-request");
    const calls = await scripted(page, JUDGE_CLOCK);
    await moveButton(page, "first-request").click();
    await expect(panel(page).getByRole("heading", { name: stepById("delegate").title.es })).toBeVisible();
    expect(inputOf(calls, "clock.advanceTo")).toEqual({ toSim: "2026-10-15T10:00:00-03:00" });
  });

  test("'Qué mirar' reads its hours from the pending timers of 4471, not from the text", async ({ page }) => {
    await startAt(page, "delegate");
    await scripted(page, {
      ...JUDGE_CLOCK,
      simNow: "2026-10-15T10:07:00-03:00",
      nextEvents: [
        { operationId: "op-4471", operationNumber: "4471", kind: "DEFERRED_SEND", timerId: "ds-1", dueAtSim: "2026-10-15T21:30:00-03:00" },
        { operationId: "op-4474", operationNumber: "4474", kind: "DEFERRED_SEND", timerId: "ds-2", dueAtSim: "2026-10-15T20:00:00-03:00" },
      ],
    });
    await expect(panel(page)).toContainText("hasta las 15/10 21:30 (16/10 08:30 en Qingdao)");
  });

  test("moves the ETA of 4471 two days earlier from the ETA it has now", async ({ page }) => {
    await startAt(page, "eta");
    const calls = await scripted(page, JUDGE_CLOCK);
    await moveButton(page, "eta").click();
    await expect(panel(page).getByRole("heading", { name: stepById("approve").title.es })).toBeVisible();
    expect(inputOf(calls, "clock.moveEta")).toEqual({ operationId: "op-4471", eta: "2026-10-20T08:00:00-03:00" });
  });

  test("approving asks for the password when the sign-in is old, and approves 4471 once it is recent", async ({ page }) => {
    await startAt(page, "approve");
    let refused = false;
    const calls = await scripted(page, JUDGE_CLOCK, {
      "dossier.approve": () => {
        if (refused) return { data: { ok: true } };
        refused = true;
        return { error: { code: "FORBIDDEN", httpStatus: 403, reason: "LOGIN_NOT_RECENT" } };
      },
    });
    await moveButton(page, "approve").click();
    await expect(panel(page).getByRole("button", { name: dataCopy.recentLogin.confirm })).toBeVisible();
    await moveButton(page, "approve").click();
    await expect(panel(page).getByRole("heading", { name: stepById("dispatch").title.es })).toBeVisible();
    expect(calls.filter((call) => call.path === "dossier.approve").map((call) => call.input)).toEqual([{ operationId: "op-4471" }, { operationId: "op-4471" }]);
  });

  test("shows the English gloss of the step's message from the simulator's thread of 4471", async ({ page }) => {
    await startAt(page, "first-request");
    const gloss = "Hi, we are writing from Estudio Delta. Operation 4471 … How do we proceed?";
    await scripted(page, JUDGE_CLOCK, {
      "simulator.threads": {
        data: {
          threads: [
            {
              importerId: "imp-norpampa",
              importerName: "Norpampa Insumos SRL",
              contactName: "Lucía Benítez",
              phoneMasked: "+54*******0101",
              operations: [{ operationId: "op-4471", operationNumber: "4471" }],
              messages: [{ messageId: "m-1", direction: "OUT", operationNumber: "4471", kind: "DOCS_REQUEST", body: "Hola…", status: "SENT", sentAtSim: "2026-10-15T10:00:30-03:00", glossEn: gloss }],
            },
          ],
        },
      },
    });
    await expect(panel(page).getByRole("region", { name: es.gloss })).toContainText(gloss);
  });
});
