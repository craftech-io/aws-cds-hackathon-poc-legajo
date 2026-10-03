// FL-065, FL-087 · reloj de demo (docs/flows-catalog.md). Against the local UI server, the real
// `clock.get` shows the paused world of Estudio Delta at 14/10 10:30 with its epoch, and "Reiniciar
// demo" is open to a broker and closed to an analyst. A guest who signed up alone then moves its own
// world (built from the `guest` template, so no other spec sees it) through the real procedures:
// `clock.advanceTo` to its next event, `clock.fireMilestone` on 4471 and `clock.reset` with its epoch
// and 10-minute window. Scripted answers check what the real world cannot show on demand: the busy
// world (controls closed with what it waits for, "Avanzar igual" only after five minutes), what each
// control sends, `WORLD_BUSY` and the guest world's `QUOTA_EXCEEDED` notice. Nothing leaves the machine.
import { type APIRequestContext, type Page, type TestInfo, expect, test } from "@playwright/test";
import { createVerifiedGuest, routeCognitoToServer, testMailbox, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { quotaMessage } from "../src/views/auth/quota.ts";
import { copy } from "../src/copy/console.ts";
import { dataCopy } from "../src/copy/console-data.ts";
import { clockCopy } from "../src/views/clock/copy.ts";
import { type ApiCall, CLOCK_AT_START, routeApi, shellApi } from "./support/api-route";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { UI_SERVER_URL } from "./support/env";
import { type PersonaName, plantSession } from "./support/session";

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

function section(page: Page, title: string) {
  return page.getByRole("region", { name: title, exact: true });
}

test.describe("reloj de demo against the real clock.get", () => {
  test("shows the paused world at its start with its epoch, and the operations of the world", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto("/app/clock");
    await expectView(page, "clock");
    const now = page.getByRole("region", { name: clockCopy.now.title });
    await expect(now).toContainText("mié 14/10 10:30");
    await expect(now).toContainText(clockCopy.now.paused);
    await expect(now).toContainText(clockCopy.now.epoch);
    await expect(section(page, clockCopy.events.title)).toContainText(clockCopy.events.empty);
    await expect(section(page, clockCopy.operation.title).getByLabel(clockCopy.operation.select)).toContainText("4471");
    await expect(section(page, clockCopy.move.title).getByRole("button", { name: clockCopy.move.live })).toBeEnabled();
    await expect(section(page, clockCopy.reset.title).getByRole("button", { name: clockCopy.reset.open })).toBeEnabled();
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  test("an analyst cannot reset the world, and is told why", async ({ page }) => {
    await plantSession(page, "analyst");
    await page.goto("/app/clock");
    await expectView(page, "clock");
    const reset = section(page, clockCopy.reset.title);
    await expect(reset.getByRole("button", { name: clockCopy.reset.open })).toBeDisabled();
    await expect(reset).toContainText(clockCopy.reset.onlyApprovers);
  });
});

// Fixture password of the in-memory pool: it never leaves this machine.
const GUEST_PASSWORD = "Clave-de-Prueba-2026!";

/** A guest who signed up alone, in its own world built from the `guest` template, on the clock view. */
async function ownGuestWorld(page: Page, request: APIRequestContext, info: TestInfo, key: string): Promise<void> {
  const email = testMailbox(info, key);
  await routeCognitoToServer(page, UI_SERVER_URL);
  await useViewerIp(page, testViewerIp(info));
  await createVerifiedGuest(request, UI_SERVER_URL, email, GUEST_PASSWORD);
  const login = AUTH_COPY.es.login;
  await page.goto("/login");
  await page.getByLabel(login.login).fill(email);
  await page.getByLabel(login.password, { exact: true }).fill(GUEST_PASSWORD);
  await page.getByRole("button", { name: login.submit }).click();
  await expect(page).toHaveURL(/\/app\/operations/, { timeout: 30_000 });
  await page.goto("/app/clock");
  await expectView(page, "clock");
}

function tile(page: Page, label: string) {
  return page.getByRole("region", { name: clockCopy.now.title }).getByText(label, { exact: true }).locator("..");
}

test.describe("the clock of a guest's own world (the real procedures)", () => {
  test("[FL-065] goes to the next event of the world through clock.advanceTo, and the hour moves to it", async ({ page, request }, info) => {
    await ownGuestWorld(page, request, info, "clk1");
    const events = section(page, clockCopy.events.title);
    const first = events.getByRole("row").nth(1);
    const when = (await first.locator("time").getAttribute("datetime")) ?? "";
    expect(when).not.toBe("");
    await first.getByRole("button", { name: clockCopy.events.goThere }).click();
    await expect(events.getByText(clockCopy.done.moved)).toBeVisible();
    await expect(tile(page, clockCopy.now.simNow).locator("time")).toHaveAttribute("datetime", new Date(when).toISOString());
  });

  test("[FL-065] a milestone of 4471 fires now without moving the clock, and the world waits for it", async ({ page, request }, info) => {
    await ownGuestWorld(page, request, info, "clk2");
    const operation = section(page, clockCopy.operation.title);
    const select = operation.getByLabel(clockCopy.operation.select);
    await select.selectOption((await select.locator("option", { hasText: "4471" }).getAttribute("value")) ?? "");
    const simNow = await tile(page, clockCopy.now.simNow).locator("time").getAttribute("datetime");
    await operation.getByRole("combobox", { name: clockCopy.operation.milestone }).selectOption("DOCS_REQUEST");
    await operation.getByRole("button", { name: clockCopy.operation.milestoneSubmit }).click();
    await expect(operation.getByText(clockCopy.done.event)).toBeVisible();
    await expect(tile(page, clockCopy.now.simNow).locator("time")).toHaveAttribute("datetime", simNow ?? "");
    // The milestone hands a turn to the agent: the world is busy until it ends, so time cannot move meanwhile.
    await expect(section(page, clockCopy.move.title).getByRole("button", { name: clockCopy.move.advanceToSubmit })).toBeDisabled();
  });

  test("[FL-087] a guest resets its own world after confirming: the epoch goes up and the clock is back at its start", async ({ page, request }, info) => {
    await ownGuestWorld(page, request, info, "clk3");
    const epoch = tile(page, clockCopy.now.epoch);
    const before = Number((await epoch.innerText()).match(/\d+/)?.[0]);
    const reset = section(page, clockCopy.reset.title);
    await reset.getByRole("button", { name: clockCopy.reset.open }).click();
    await reset.getByRole("button", { name: clockCopy.reset.confirm }).click();
    await expect(reset.getByText(clockCopy.reset.done)).toBeVisible();
    await expect(epoch).toContainText(String(before + 1));
    await expect(tile(page, clockCopy.now.simNow)).toContainText("mié 14/10 10:30");
    await expect(reset.getByRole("button", { name: clockCopy.reset.open })).toBeDisabled();
    await expect(reset).toContainText(/se puede volver a reiniciar a las \d{2}:\d{2}/);
  });
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const WORLD = {
  ...CLOCK_AT_START,
  startAtSim: "2026-10-14T10:30:00-03:00",
  worldEpoch: 2,
  nextEvents: [{ operationId: "op-4471", operationNumber: "4471", kind: "DEFERRED_SEND", timerId: "ds-1", dueAtSim: "2026-10-15T22:00:00-03:00", reason: "CP-HOURS-SUPPLIER" }],
  reset: { allowed: true },
};

const OPERATIONS = {
  clockId: "GLOBAL#firm-delta",
  operations: [{ operationId: "op-4471", operationNumber: "4471", importerName: "Norpampa Insumos SRL", eta: "2026-10-22T08:00:00-03:00", dossierStatus: "OPEN" }],
};

async function scripted(page: Page, world: Record<string, unknown>, overrides: Parameters<typeof shellApi>[0] = {}, persona: PersonaName = "broker"): Promise<ApiCall[]> {
  const calls = await routeApi(
    page,
    shellApi({
      "clock.get": { data: world },
      "operations.list": { data: OPERATIONS },
      "clock.advanceTo": { data: world },
      "clock.setRunning": { data: world },
      "clock.moveEta": { data: world },
      "clock.fireMilestone": { data: world },
      "clock.emitDispatchStatus": { data: world },
      "clock.reset": { data: world },
      ...overrides,
    }),
  );
  await plantSession(page, persona);
  await page.goto("/app/clock");
  await expectView(page, "clock");
  return calls;
}

const inputOf = (calls: readonly ApiCall[], path: string) => calls.find((call) => call.path === path)?.input;

test.describe("time controls (scripted answers)", () => {
  test("while the world is busy every control that moves time is closed, saying what it waits for", async ({ page }) => {
    const calls = await scripted(page, { ...WORLD, busy: true, pending: [{ kind: "MAIL", operationNumber: "4471", sinceReal: ago(60_000) }] });
    const events = section(page, clockCopy.events.title);
    await expect(events.getByRole("button", { name: clockCopy.events.goThere })).toBeDisabled();
    await expect(events).toContainText(copy.clock.pending.MAIL);
    await expect(section(page, clockCopy.move.title).getByRole("button", { name: clockCopy.move.advanceToSubmit })).toBeDisabled();
    await expect(section(page, clockCopy.operation.title).getByRole("button", { name: clockCopy.operation.etaSubmit })).toBeDisabled();
    await expect(section(page, clockCopy.operation.title).getByRole("button", { name: clockCopy.operation.milestoneSubmit })).toBeDisabled();
    await expect(section(page, clockCopy.operation.title).getByRole("button", { name: clockCopy.operation.dispatchSubmit })).toBeDisabled();
    await expect(page.getByText(clockCopy.gate.force)).toHaveCount(0);
    expect(calls.some((call) => call.path.startsWith("clock.advance"))).toBe(false);
  });

  test("after five busy minutes the controls open again with the warning, and a move goes with force", async ({ page }) => {
    const calls = await scripted(page, { ...WORLD, busy: true, pending: [{ kind: "EVENT", operationNumber: "4471", sinceReal: ago(6 * 60_000) }] });
    const events = section(page, clockCopy.events.title);
    await expect(events.getByText(clockCopy.gate.force)).toBeVisible();
    await events.getByRole("button", { name: clockCopy.events.goThere }).click();
    await expect.poll(() => inputOf(calls, "clock.advanceTo")).toEqual({ toSim: "2026-10-15T22:00:00-03:00", force: true });
  });

  test("a quiet world lists the next events with their reason and goes to one", async ({ page }) => {
    const calls = await scripted(page, WORLD);
    const row = section(page, clockCopy.events.title).getByRole("row", { name: /Envío diferido/ });
    await expect(row).toContainText("jue 15/10 22:00");
    await expect(row).toContainText("CP-HOURS-SUPPLIER");
    await row.getByRole("button", { name: clockCopy.events.goThere }).click();
    await expect(section(page, clockCopy.events.title).getByText(clockCopy.done.moved)).toBeVisible();
    expect(inputOf(calls, "clock.advanceTo")).toEqual({ toSim: "2026-10-15T22:00:00-03:00" });
  });

  test("the events of an operation: the carrier moves the ETA, a milestone fires now, customs reports a status", async ({ page }) => {
    const calls = await scripted(page, WORLD);
    const operation = section(page, clockCopy.operation.title);
    await operation.getByRole("button", { name: clockCopy.operation.etaEarlier }).click();
    await operation.getByRole("button", { name: clockCopy.operation.etaSubmit }).click();
    await expect.poll(() => inputOf(calls, "clock.moveEta")).toEqual({ operationId: "op-4471", eta: "2026-10-20T08:00:00-03:00" });

    await operation.getByRole("combobox", { name: clockCopy.operation.milestone }).selectOption("FOLLOWUP");
    await operation.getByRole("button", { name: clockCopy.operation.milestoneSubmit }).click();
    await expect.poll(() => inputOf(calls, "clock.fireMilestone")).toEqual({ operationId: "op-4471", milestone: "FOLLOWUP" });

    await operation.getByRole("combobox", { name: clockCopy.operation.dispatch }).selectOption("CANAL_ASIGNADO#NARANJA");
    await operation.getByRole("button", { name: clockCopy.operation.dispatchSubmit }).click();
    await expect.poll(() => inputOf(calls, "clock.emitDispatchStatus")).toEqual({ operationId: "op-4471", status: "CANAL_ASIGNADO", channel: "NARANJA" });
  });

  test("a move the BFF refuses with WORLD_BUSY says the world is busy", async ({ page }) => {
    await scripted(page, WORLD, { "clock.advanceTo": { error: { code: "PRECONDITION_FAILED", httpStatus: 412, reason: "WORLD_BUSY" } } });
    const events = section(page, clockCopy.events.title);
    await events.getByRole("button", { name: clockCopy.events.goThere }).click();
    await expect(events.getByText(dataCopy.byReason.WORLD_BUSY ?? "")).toBeVisible();
  });

  test("the live clock runs for 30 minutes", async ({ page }) => {
    const calls = await scripted(page, WORLD);
    await section(page, clockCopy.move.title).getByRole("button", { name: clockCopy.move.live }).click();
    await expect.poll(() => inputOf(calls, "clock.setRunning")).toEqual({ running: true });
  });

  test("'Reiniciar demo' asks first, then resets this world; within 10 minutes it says when it opens again", async ({ page }) => {
    const calls = await scripted(page, WORLD);
    const reset = section(page, clockCopy.reset.title);
    await reset.getByRole("button", { name: clockCopy.reset.open }).click();
    await expect(reset.getByText(clockCopy.reset.confirmTitle)).toBeVisible();
    expect(inputOf(calls, "clock.reset")).toBeUndefined();
    await reset.getByRole("button", { name: clockCopy.reset.confirm }).click();
    await expect(reset.getByText(clockCopy.reset.done)).toBeVisible();
    expect(inputOf(calls, "clock.reset")).toEqual({});
  });

  test("a world reset less than 10 minutes ago keeps the reset closed until its hour", async ({ page }) => {
    await scripted(page, { ...WORLD, reset: { allowed: false, nextAllowedAtReal: "2026-10-15T13:12:00.000Z" } });
    const reset = section(page, clockCopy.reset.title);
    await expect(reset.getByRole("button", { name: clockCopy.reset.open })).toBeDisabled();
    await expect(reset).toContainText(clockCopy.reset.wait("10:12"));
  });

  test("a move past the guest world's quota opens the quota notice with its renewal hour, and the hour stays", async ({ page }) => {
    const quota = { kind: "CLOCK_MOVES", resetsAtReal: new Date(Date.UTC(2030, 0, 2)).toISOString() } as const;
    const refusal = { code: "TOO_MANY_REQUESTS", httpStatus: 429, reason: "QUOTA_EXCEEDED", quota };
    await scripted(page, { ...WORLD, clockId: "GUEST#firm-guest-01" }, { "clock.advanceTo": { error: refusal } }, "guest");
    await section(page, clockCopy.events.title).getByRole("button", { name: clockCopy.events.goThere }).click();
    await expect(page.getByRole("alert").filter({ hasText: quotaMessage(AUTH_COPY.es, quota) })).toBeVisible();
    await expect(page.getByRole("region", { name: clockCopy.now.title })).toContainText("mié 14/10 10:30");
    await expect(section(page, clockCopy.events.title).getByText(clockCopy.done.moved)).toHaveCount(0);
  });

  test("a reset past the guest world's quota of resets opens the quota notice", async ({ page }) => {
    const quota = { kind: "WORLD_RESETS", resetsAtReal: new Date(Date.UTC(2030, 0, 1, 15, 40)).toISOString() } as const;
    const refusal = { code: "TOO_MANY_REQUESTS", httpStatus: 429, reason: "QUOTA_EXCEEDED", quota };
    await scripted(page, { ...WORLD, clockId: "GUEST#firm-guest-01" }, { "clock.reset": { error: refusal } }, "guest");
    const reset = section(page, clockCopy.reset.title);
    await reset.getByRole("button", { name: clockCopy.reset.open }).click();
    await reset.getByRole("button", { name: clockCopy.reset.confirm }).click();
    await expect(page.getByRole("alert").filter({ hasText: quotaMessage(AUTH_COPY.es, quota) })).toBeVisible();
    await expect(reset.getByText(clockCopy.reset.done)).toHaveCount(0);
  });
});
