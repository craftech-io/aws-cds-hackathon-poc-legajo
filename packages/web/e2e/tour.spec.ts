// The guest's guided tour (docs/design-brief.md §15, views/tour/steps.ts). Against the local UI
// server a guest finds the panel open with step 1, its hour read from the real `clock.get` of its
// world, in Spanish or English, and a second session on the same guest world gets the shell's fixed
// notice from the real `account.session`. Scripted answers then walk the buttons: each waits for a
// quiet world and sends its move to `tour.run` (which runs `clock.advanceTo` at 15/10 10:00,
// `clock.moveEta` from the ETA of 4471 or `dossier.approve` on the server), fills "Qué mirar" from the
// pending timers of 4471 that `tour.steps` answers and shows the English gloss of the step's message.
// Nothing leaves the machine.
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

test.describe("the guided tour against the real world of a guest", () => {
  test("opens with step 1 and the hour of the world's start, in Spanish or English", async ({ page }) => {
    await plantSession(page, "guest");
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
  test("a second session on the same guest world gets the fixed notice, without a reset", async ({ page, browser }) => {
    await plantSession(page, "guest", { signedInAgo: 3_600 });
    const recorded = page.waitForResponse((response) => response.url().includes("account.session") && response.ok());
    await page.goto("/app/operations");
    await recorded;

    const { baseURL, locale, timezoneId } = test.info().project.use;
    const other = await browser.newContext({ baseURL, locale, timezoneId });
    const second = await other.newPage();
    await plantSession(second, "guest", { signedInAgo: 5 });
    await second.goto("/app/operations");
    const notice = second.getByRole("alert").filter({ hasText: copy.session.otherSessionEn });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/Otra sesión usó este mundo hace/);
    await expect(notice.getByRole("button")).toHaveCount(0);
    await other.close();
  });
});

const OPERATIONS = {
  clockId: "GUEST#firm-guest-01",
  operations: [
    {
      operationId: "op-4471",
      operationNumber: "4471",
      clockId: "GUEST#firm-guest-01",
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

const GUEST_CLOCK = { ...CLOCK_AT_START, clockId: "GUEST#firm-guest-01", worldEpoch: 1, startAtSim: "2026-10-14T10:30:00-03:00", nextEvents: [] };

/** Progress of the tour stored as if the guest had done every move before `id`. */
async function startAt(page: Page, id: TourStep["id"]): Promise<void> {
  const before = TOUR_STEPS.slice(0, TOUR_STEPS.findIndex((step) => step.id === id)).flatMap((step) => step.moves.map((_, index) => `${step.id}#${index}`));
  await page.addInitScript((done) => window.sessionStorage.setItem("legajo.tour.GUEST#firm-guest-01#1", JSON.stringify(done)), before);
}

/** `tour.steps` of the scripted world: operation 4471 and its pending timers. */
function tourSteps(world: Record<string, unknown>, nextEvents: readonly Record<string, unknown>[] = []) {
  const [operation] = OPERATIONS.operations;
  return {
    data: {
      clockId: world["clockId"],
      worldEpoch: world["worldEpoch"],
      simNow: world["simNow"],
      startAtSim: world["startAtSim"],
      operation: operation === undefined ? null : { operationId: operation.operationId, operationNumber: operation.operationNumber, eta: operation.eta },
      nextEvents,
    },
  };
}

async function scripted(page: Page, world: Record<string, unknown>, overrides: Parameters<typeof shellApi>[0] = {}): Promise<ApiCall[]> {
  const calls = await routeApi(
    page,
    shellApi({
      "clock.get": { data: world },
      "operations.list": { data: OPERATIONS },
      "tour.steps": tourSteps(world),
      "tour.run": (input) => ({ data: { kind: (input as { action: { kind: string } }).action.kind, done: true } }),
      "simulator.threads": { data: { threads: [] } },
      ...overrides,
    }),
  );
  await plantSession(page, "guest");
  // The clock view reads only what is scripted here; the panel is the same on every view.
  await page.goto("/app/clock");
  return calls;
}

const inputOf = (calls: readonly ApiCall[], path: string) => calls.find((call) => call.path === path)?.input;

test.describe("the tour's buttons (scripted answers)", () => {
  // The progress is kept per world and epoch: a move taken before `clock.get` names the world would be
  // kept under no key and dropped when the world's key arrives, sending the panel back to step 1.
  test("[FL-079] opens no button before the world is known, so the first move is kept once it is", async ({ page }) => {
    await scripted(page, GUEST_CLOCK, { "clock.get": { data: GUEST_CLOCK, delayMs: 2_000 } });
    const open = moveButton(page, "sign-in");
    await expect(open).toBeDisabled();
    await expect(open).toBeEnabled({ timeout: 10_000 });
    await open.click();
    await expect(panel(page).getByRole("heading", { name: stepById("first-request").title.es })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("legajo.tour.GUEST#firm-guest-01#1"))).toContain("sign-in#0");
    await page.reload();
    await expect(panel(page).getByRole("heading", { name: stepById("first-request").title.es })).toBeVisible({ timeout: 10_000 });
  });

  test("a button that changes the world waits for a quiet one, then goes to the 4471 request at 15/10 10:00", async ({ page }) => {
    await startAt(page, "first-request");
    const calls = await scripted(page, { ...GUEST_CLOCK, busy: true, pending: [{ kind: "EVENT", operationNumber: "4471", sinceReal: new Date().toISOString() }] });
    await expect(moveButton(page, "first-request")).toBeDisabled();
    await expect(panel(page).getByText(es.busy)).toBeVisible();
    expect(inputOf(calls, "tour.run")).toBeUndefined();
  });

  test("goes to the 4471 request at 15/10 10:00 and moves on to the next step", async ({ page }) => {
    await startAt(page, "first-request");
    const calls = await scripted(page, GUEST_CLOCK);
    await moveButton(page, "first-request").click();
    await expect(panel(page).getByRole("heading", { name: stepById("delegate").title.es })).toBeVisible();
    expect(inputOf(calls, "tour.run")).toEqual({ action: { kind: "advanceTo", toSim: "2026-10-15T10:00:00-03:00" } });
  });

  test("'Qué mirar' reads its hours from the pending timers of 4471, not from the text", async ({ page }) => {
    await startAt(page, "delegate");
    const world = { ...GUEST_CLOCK, simNow: "2026-10-15T10:07:00-03:00" };
    await scripted(page, world, {
      "tour.steps": tourSteps(world, [{ operationId: "op-4471", operationNumber: "4471", kind: "DEFERRED_SEND", dueAtSim: "2026-10-15T21:30:00-03:00" }]),
    });
    await expect(panel(page)).toContainText("hasta las 15/10 21:30 (16/10 08:30 en Qingdao)");
  });

  test("asks for the ETA of 4471 two days earlier than the ETA it has now", async ({ page }) => {
    await startAt(page, "eta");
    const calls = await scripted(page, GUEST_CLOCK);
    await moveButton(page, "eta").click();
    await expect(panel(page).getByRole("heading", { name: stepById("approve").title.es })).toBeVisible();
    expect(inputOf(calls, "tour.run")).toEqual({ action: { kind: "moveEta", shiftDays: -2 } });
  });

  test("approving asks for the password when the sign-in is old, and approves 4471 once it is recent", async ({ page }) => {
    await startAt(page, "approve");
    let refused = false;
    const calls = await scripted(page, GUEST_CLOCK, {
      "tour.run": () => {
        if (refused) return { data: { kind: "approve", done: true } };
        refused = true;
        return { error: { code: "FORBIDDEN", httpStatus: 403, reason: "LOGIN_NOT_RECENT" } };
      },
    });
    await moveButton(page, "approve").click();
    await expect(panel(page).getByRole("button", { name: dataCopy.recentLogin.confirm })).toBeVisible();
    await moveButton(page, "approve").click();
    await expect(panel(page).getByRole("heading", { name: stepById("dispatch").title.es })).toBeVisible();
    expect(calls.filter((call) => call.path === "tour.run").map((call) => call.input)).toEqual([{ action: { kind: "approve" } }, { action: { kind: "approve" } }]);
  });

  test("shows the English gloss of the step's message from the simulator's thread of 4471", async ({ page }) => {
    await startAt(page, "first-request");
    const gloss = "Hi, we are writing from Estudio Delta. Operation 4471 … How do we proceed?";
    await scripted(page, GUEST_CLOCK, {
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
