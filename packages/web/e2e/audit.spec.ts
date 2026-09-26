// FL-086 · bitácora (docs/flows-catalog.md), against the local UI server: the real `audit.list`,
// `audit.violations` and `audit.decisionsByRule` over the in-memory world of Estudio Delta. The
// violations counter reads 0 next to the DENY and DEFER decisions by rule, and the operation and
// decision filters reach `audit.list`. A scripted answer then checks how decisions read (rules,
// trigger, actor, operation, never a raw code) and the rule and actor filters. Nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { auditCopy } from "../src/views/audit/copy.ts";
import { routeApi, shellApi } from "./support/api-route";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { plantSession } from "./support/session";

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

function decisions(page: Page) {
  return page.getByRole("region", { name: auditCopy.list.title, exact: true });
}

function listRequest(page: Page, fragment: string) {
  return page.waitForRequest((request) => request.url().includes("audit.list") && decodeURIComponent(request.url()).includes(fragment));
}

test.describe("[FL-086] bitácora", () => {
  test("[FL-086] the violations counter reads 0 next to the decisions by rule, and the filters reach audit.list", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto("/app/audit");
    await expectView(page, "audit");

    const counters = page.getByRole("region", { name: auditCopy.counters.title });
    await expect(counters.getByText(auditCopy.counters.violations, { exact: true }).locator("xpath=..")).toContainText("0");
    await expect(page.getByRole("region", { name: auditCopy.byRule.title })).toContainText(auditCopy.byRule.empty);
    await expect(decisions(page)).toContainText(auditCopy.list.empty);

    const denied = listRequest(page, '"decision":"DENY"');
    await decisions(page).getByRole("button", { name: "Denegadas" }).click();
    await denied;
    await expect(decisions(page).getByRole("button", { name: "Denegadas" })).toHaveAttribute("aria-pressed", "true");

    const byOperation = listRequest(page, '"operationId":"op-4471"');
    await decisions(page).getByLabel(auditCopy.filters.operation).selectOption({ label: "4471" });
    await byOperation;
    await expect(decisions(page)).toContainText(auditCopy.list.empty);

    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  test("[FL-086] another firm reads its own log only: an operation of Estudio Delta is not offered", async ({ page }) => {
    await plantSession(page, "otherFirm");
    await page.goto("/app/audit");
    await expectView(page, "audit");
    await expect(decisions(page).getByLabel(auditCopy.filters.operation).locator("option")).toHaveText([auditCopy.filters.allOperations]);
  });
});

const ROWS = [
  {
    decisionId: "d1",
    ts: "2026-10-16T01:00:00.000Z",
    decision: "DEFER",
    action: "SEND_EMAIL",
    ruleIds: ["CP-HOURS-SUPPLIER"],
    evaluated: [],
    actor: "AGENT",
    refs: {},
    operationId: "op-4471",
    trigger: "CONTACT_CONFIRMED",
    atSim: "2026-10-15T10:07:00-03:00",
    atReal: "2026-09-26T15:00:00.000Z",
  },
  {
    decisionId: "d2",
    ts: "2026-10-15T13:05:00.000Z",
    decision: "ACTION",
    action: "CONSENT_GRANTED",
    ruleIds: [],
    evaluated: [],
    actor: "BROKER:brk-delta-martina",
    refs: {},
    operationId: "op-4473",
    atSim: "2026-10-15T10:05:00-03:00",
    atReal: "2026-09-26T15:00:00.000Z",
  },
];

test.describe("decisions with rows (scripted answers)", () => {
  test("decisions read with rule, trigger, actor and operation, and filter by rule and actor", async ({ page }) => {
    await routeApi(
      page,
      shellApi({
        "audit.violations": { data: { clockId: "GLOBAL#firm-delta", count: 0, violations: [] } },
        "audit.decisionsByRule": { data: { clockId: "GLOBAL#firm-delta", byRule: { "CP-HOURS-SUPPLIER": { deny: 0, defer: 1 } } } },
        "audit.list": { data: { clockId: "GLOBAL#firm-delta", decisions: ROWS } },
        "operations.list": { data: { clockId: "GLOBAL#firm-delta", operations: [] } },
      }),
    );
    await plantSession(page, "broker");
    await page.goto("/app/audit");

    const table = decisions(page);
    await expect(table.getByRole("row", { name: /Email al proveedor/ })).toContainText("Diferido");
    await expect(table.getByRole("row", { name: /Email al proveedor/ })).toContainText("Contacto confirmado");
    await expect(table.getByRole("row", { name: /Email al proveedor/ })).toContainText("4471");
    await expect(table.getByRole("row", { name: /Opt-in registrado/ })).toContainText("Persona del estudio");
    await expect(page.getByRole("region", { name: auditCopy.byRule.title }).getByRole("row", { name: /CP-HOURS-SUPPLIER/ })).toBeVisible();

    await table.getByLabel(auditCopy.filters.rule).selectOption("CP-HOURS-SUPPLIER");
    await expect(table.getByRole("row", { name: /Opt-in registrado/ })).toHaveCount(0);
    await expect(table.getByRole("row", { name: /Email al proveedor/ })).toBeVisible();

    await table.getByLabel(auditCopy.filters.rule).selectOption("ALL");
    await table.getByLabel(auditCopy.filters.actor).selectOption({ label: "Persona del estudio" });
    await expect(table.getByRole("row", { name: /Email al proveedor/ })).toHaveCount(0);
    await expect(table.getByRole("row", { name: /Opt-in registrado/ })).toBeVisible();
    await expectNoRawCodes(page);
  });
});
