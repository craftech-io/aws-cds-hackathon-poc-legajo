// FL-080 · the list of operations, and FL-005 · a new operation from the platform (docs/flows-catalog.md),
// against the local UI server: Vite, the real `appRouter` over an in-memory world (Estudio Delta with
// its operation 4471, Estudio Norte empty), the platform mock in process (4471 and the free number
// 4479 for Delta) and the BFF's real token verifier. Also the escalations inbox of the same group of
// views. Nothing leaves the machine. The tests run in order: FL-005 adds 4479 to Delta's world last,
// so the counts the filters of FL-080 read never change under them.
import { type Locator, type Page, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import { dossierCopy } from "../src/views/dossier/copy.ts";
import { escalationsCopy } from "../src/views/escalations/copy.ts";
import { controlLabel, docTypeLabel, dossierStatusLabel, riskLabel, timerTitle } from "../src/views/dossier/labels.ts";
import { operationsCopy } from "../src/views/operations/copy.ts";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { plantSession } from "./support/session";

test.describe.configure({ mode: "serial" });

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

function table(page: Page) {
  return page.getByRole("table", { name: operationsCopy.caption });
}

function bodyRows(page: Page) {
  return table(page).locator("tbody > tr");
}

function mainRow(page: Page) {
  return bodyRows(page).filter({ hasText: operationsCopy.mainStory });
}

/** The option of a filter group and the rows it says it would show: "Aprobados (2)" → 2. */
async function option(group: Locator, label: string): Promise<{ readonly button: Locator; readonly count: number }> {
  const button = group.getByRole("button", { name: new RegExp(`^${label} \\(\\d+\\)$`) });
  const count = Number(/\((\d+)\)$/.exec(await button.innerText())?.[1] ?? Number.NaN);
  return { button, count };
}

/** Shows exactly `count` rows, or the empty state of the filters when that is 0. */
async function expectRows(page: Page, count: number): Promise<void> {
  if (count === 0) await expect(page.getByText(operationsCopy.emptyFiltered.title)).toBeVisible();
  else await expect(bodyRows(page)).toHaveCount(count);
}

test.describe("[FL-080] lista de operaciones", () => {
  test("[FL-080] an analyst of Delta sees the operations of the firm's world, the 4471 pinned on top as the main story", async ({ page }) => {
    await plantSession(page, "analyst");
    await page.goto("/app/operations");
    await expectView(page, "operations");

    // Pinned on top: the first row of the table, whatever else the world holds.
    const row = bodyRows(page).first();
    await expect(row).toContainText(operationsCopy.mainStory);
    await expect(row).toContainText("4471");
    await expect(row).toContainText("Norpampa Insumos SRL");
    await expect(row).toContainText("Qingdao Bluewave Textiles Co., Ltd.");
    await expect(row).toContainText("Austral Aurora");
    await expect(row).toContainText("jue 22/10 08:00");
    await expect(row).toContainText(/\d+ d \d+ h|\d+ h|Ya arribó/);
    await expect(row).toContainText(dossierStatusLabel.OPEN);
    await expect(row).toContainText(controlLabel.AGENT);
    await expect(row).toContainText(new RegExp(`${riskLabel.ON_TRACK}|${riskLabel.AT_RISK}`));
    for (const document of ["Factura comercial", "Packing list", "Certificado de origen"]) {
      await expect(row.getByText(`${document}: faltante`)).toBeAttached();
    }
    await expect(page.getByText(operationsCopy.fictitious)).toBeVisible();
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  test("[FL-080] filters by dossier status, risk and ETA range, each option with the rows it would show", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto("/app/operations");
    const status = page.getByRole("group", { name: operationsCopy.filters.status });
    const risk = page.getByRole("group", { name: operationsCopy.filters.risk });
    const all = await option(status, operationsCopy.filters.all);
    await expect(all.button).toHaveAttribute("aria-pressed", "true");
    await expectRows(page, all.count);
    expect((await option(status, operationsCopy.filters.statuses.OPEN)).count).toBeGreaterThanOrEqual(1);

    const approved = await option(status, operationsCopy.filters.statuses.APPROVED);
    await approved.button.click();
    await expect(approved.button).toHaveAttribute("aria-pressed", "true");
    await expectRows(page, approved.count);
    for (const row of await bodyRows(page).all()) await expect(row).toContainText(dossierStatusLabel.APPROVED);
    await all.button.click();
    await expectRows(page, all.count);

    const complete = await option(risk, operationsCopy.filters.risks.COMPLETE);
    await complete.button.click();
    await expectRows(page, complete.count);
    await expect(mainRow(page)).toHaveCount(0);
    await (await option(risk, operationsCopy.filters.all)).button.click();
    await expect(mainRow(page)).toBeVisible();

    await page.getByLabel(copy.scope.etaTo).fill("2026-10-21");
    await expect(mainRow(page)).toHaveCount(0);
    await page.getByLabel(copy.scope.etaTo).fill("2026-10-22");
    await expect(mainRow(page)).toBeVisible();
  });

  test("[FL-080] a row opens the dossier of its operation, by click and by keyboard", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto("/app/operations");
    await mainRow(page).getByText("Norpampa Insumos SRL").click();
    await expect(page).toHaveURL(/\/app\/operations\/op-4471$/);
    await expectView(page, "dossier");

    await page.goBack();
    await expectView(page, "operations");
    await mainRow(page).focus();
    await page.keyboard.press("Enter");
    await expectView(page, "dossier");
    await page.goBack();
    await page.getByRole("link", { name: operationsCopy.openDossier("4471"), exact: false }).click();
    await expectView(page, "dossier");
  });

  test("[FL-080] a broker of another firm sees none of Delta's operations", async ({ page }) => {
    await plantSession(page, "otherFirm");
    await page.goto("/app/operations");
    await expect(page.getByText(operationsCopy.empty.title)).toBeVisible();
    const content = page.locator("#content");
    await expect(content.getByText("4471")).toHaveCount(0);
    await expect(content.getByText("Norpampa Insumos SRL")).toHaveCount(0);
  });
});

test.describe("escalamientos", () => {
  test("the inbox of Delta's world opens empty, accessible and in words", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto("/app/escalations");
    await expectView(page, "escalations");
    await expect(page.getByText(escalationsCopy.empty.title)).toBeVisible();
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });
});

test.describe("nueva operación desde la plataforma", () => {
  test("the form asks for the four digits of the platform's number before calling the BFF, and says when the platform has no such operation", async ({ page }) => {
    await plantSession(page, "analyst");
    await page.goto("/app/operations");
    await page.getByRole("button", { name: operationsCopy.create.open }).click();
    const drawer = page.getByRole("dialog", { name: operationsCopy.create.title });
    await expect(drawer).toBeVisible();
    await drawer.getByLabel(operationsCopy.create.number).fill("44");
    await drawer.getByRole("button", { name: operationsCopy.create.submit }).click();
    await expect(drawer.getByText(operationsCopy.create.invalid)).toBeVisible();
    await expectAccessibleBasics(page);
    // Four digits the platform does not have for this firm: said in words, nothing created.
    await drawer.getByLabel(operationsCopy.create.number).fill("4498");
    await drawer.getByRole("button", { name: operationsCopy.create.submit }).click();
    await expect(drawer.getByText(operationsCopy.create.notFound)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });

  test("[FL-005] «Nueva operación» with a number of the platform creates the dossier with its 3 documents and 5 milestones and opens it", async ({ page }) => {
    await plantSession(page, "analyst");
    await page.goto("/app/operations");
    await page.getByRole("button", { name: operationsCopy.create.open }).click();
    const drawer = page.getByRole("dialog", { name: operationsCopy.create.title });
    await drawer.getByLabel(operationsCopy.create.number).fill("4479");
    await drawer.getByRole("button", { name: operationsCopy.create.submit }).click();

    // The new dossier opens: the platform's operation, its three documents missing, five milestones pending.
    await expect(page).toHaveURL(/\/app\/operations\/op-4479$/);
    await expectView(page, "dossier");
    await expect(page.getByText(dossierCopy.heading("4479", "Norpampa Insumos SRL", "Qingdao Bluewave Textiles Co., Ltd."))).toBeVisible();
    await expect(page.getByRole("region", { name: dossierCopy.sections.summary })).toContainText("vie 30/10 08:00");
    await expect(page.getByRole("region", { name: dossierCopy.sections.summary })).toContainText(dossierStatusLabel.OPEN);
    const documents = page.getByRole("region", { name: dossierCopy.sections.documents });
    for (const docType of ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] as const) {
      await expect(documents.getByRole("article", { name: docTypeLabel[docType] })).toContainText("Faltante");
    }
    const pending = page.getByRole("region", { name: dossierCopy.sections.pending }).getByRole("listitem");
    await expect(pending).toHaveCount(5);
    for (const milestone of ["DOCS_REQUEST", "FOLLOWUP", "FOLLOWUP_FINAL", "ESCALATION", "ARRIVAL"] as const) {
      await expect(pending.filter({ hasText: timerTitle("MILESTONE", milestone) })).toHaveCount(1);
    }
    await expect(pending.first()).toContainText("vie 23/10 10:00");
    await expectNoRawCodes(page);

    // Back on the list, 4479 is a row of Delta's world, and the 4471 stays pinned on top.
    await page.getByRole("link", { name: dossierCopy.back }).click();
    await expect(bodyRows(page).first()).toContainText(operationsCopy.mainStory);
    await expect(bodyRows(page).filter({ hasText: "4479" })).toHaveCount(1);

    // The same number again is a conflict said in words, and nothing is created twice.
    await page.getByRole("button", { name: operationsCopy.create.open }).click();
    await drawer.getByLabel(operationsCopy.create.number).fill("4479");
    await drawer.getByRole("button", { name: operationsCopy.create.submit }).click();
    await expect(drawer.getByText(operationsCopy.create.conflict)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bodyRows(page).filter({ hasText: "4479" })).toHaveCount(1);
  });
});
