// FL-065, FL-087 · reloj de demo (docs/flows-catalog.md). Against the local UI server, the real
// `clock.get` shows the paused world of Estudio Delta at 14/10 10:30 with its epoch, and "Reiniciar
// demo" is open to a broker and closed to an analyst. The moves (`clock.advanceTo`, `setRunning`,
// `fireMilestone`, `moveEta`, `emitDispatchStatus`, `reset`) are not registered in the `AppRouter`
// yet: the two flows stay declared pending, and scripted answers check the busy world (controls
// closed with what the world waits for, "Avanzar igual" only after five minutes), what each control
// sends and the reset's confirmation and 10-minute window. Nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import { dataCopy } from "../src/copy/console-data.ts";
import { clockCopy } from "../src/views/clock/copy.ts";
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

  test.fixme("[FL-065:pending] avanzar el reloj o disparar un hito: the procedures are in the AppRouter and run over the UI server's world; the spec is WP-35's", async () => {});
  test.fixme("[FL-087:pending] reiniciar la demo: the procedures are in the AppRouter and run over the UI server's world; the spec is WP-35's", async () => {});
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

async function scripted(page: Page, world: Record<string, unknown>, overrides: Parameters<typeof shellApi>[0] = {}): Promise<ApiCall[]> {
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
  await plantSession(page, "broker");
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
});
