// FL-085 · métricas con rótulos (docs/flows-catalog.md), against the local UI server: the real
// `metrics.summary` and `metrics.export` over the in-memory world of Estudio Delta (tests/ui-server),
// signed in with the run's ephemeral key. Every KPI says its N, source and label; the manual baseline
// shows its declared breakdown; the violations counter reads 0 next to the decisions by rule; the
// batch tabs never mix with "Este mundo". A scripted answer then checks how numbers, gaps and notes
// read when there are rows. Nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { metricsCopy } from "../src/views/metrics/copy.ts";
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

function tile(page: Page, title: string) {
  return page.getByText(title, { exact: true }).locator("xpath=..");
}

function tab(page: Page, label: string) {
  return page.getByRole("group", { name: metricsCopy.tabs.label }).getByRole("button", { name: label });
}

test.describe("[FL-085] métricas con rótulos", () => {
  test("[FL-085] 'Este mundo' shows each KPI with its N, source and label, the declared baseline and 0 violations", async ({ page }) => {
    await plantSession(page, "broker");
    const summaries = page.waitForResponse((response) => response.url().includes("metrics.summary") && response.ok());
    await page.goto("/app/metrics");
    await expectView(page, "metrics");
    await summaries;

    await expect(page.getByText(metricsCopy.summary(0, metricsCopy.labels.MEASURED))).toBeVisible();
    await expect(tile(page, metricsCopy.kpis.humanMinutesPerDossier)).toContainText(metricsCopy.gaps.NO_DATA);
    await expect(tile(page, metricsCopy.kpis.humanMinutesPerDossier)).toContainText(metricsCopy.hint(0, metricsCopy.sources.WORLD, metricsCopy.labels.ASSUMPTION));
    await expect(tile(page, metricsCopy.kpis.manualBaselineMinutes)).toContainText("64,0 min");
    await expect(tile(page, metricsCopy.kpis.manualBaselineMinutes)).toContainText(metricsCopy.hint(1, metricsCopy.sources.FIRM_SETTINGS, metricsCopy.labels.ASSUMPTION));
    await expect(tile(page, metricsCopy.kpis.policyViolations)).toContainText("0");
    await expect(tile(page, metricsCopy.kpis.policyViolations)).toContainText(metricsCopy.hint(0, metricsCopy.sources.AUDIT_LOG, metricsCopy.labels.MEASURED));
    await expect(tile(page, metricsCopy.kpis.consoleMinutesObserved)).toBeVisible();

    const baseline = page.getByRole("region", { name: metricsCopy.baseline.title });
    await expect(baseline.getByRole("row", { name: /Contactos por legajo/ })).toContainText("8");
    await expect(baseline).toContainText(metricsCopy.baseline.label);
    await expect(page.getByRole("region", { name: metricsCopy.byRule.title })).toBeVisible();

    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  test("[FL-085] the batch tabs are their own source: scripted agent labelled, no console time, no world decisions", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto("/app/metrics");
    await expectView(page, "metrics");

    const scripted = page.waitForRequest((request) => request.url().includes("metrics.summary") && decodeURIComponent(request.url()).includes('"tab":"BATCH_SCRIPTED"'));
    await tab(page, metricsCopy.tabs.BATCH_SCRIPTED).click();
    await scripted;
    await expect(tab(page, metricsCopy.tabs.BATCH_SCRIPTED)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(metricsCopy.summary(0, metricsCopy.labels.SCRIPTED_AGENT))).toBeVisible();
    await expect(tile(page, metricsCopy.kpis.correctResponsiblePct)).toContainText(metricsCopy.gaps.NOT_APPLICABLE);
    await expect(page.getByText(metricsCopy.kpis.consoleMinutesObserved, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: metricsCopy.byRule.title })).toHaveCount(0);

    await tab(page, metricsCopy.tabs.BATCH_REAL).click();
    await expect(page.getByText(metricsCopy.summary(0, metricsCopy.labels.MEASURED))).toBeVisible();
  });

  test("[FL-085] exports the rows behind the tab as CSV", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto("/app/metrics");
    await expectView(page, "metrics");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: metricsCopy.export.button }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("legajo-metrics-world.csv");
    await expect(page.getByText(metricsCopy.export.done)).toBeVisible();
  });
});

test.describe("metrics with rows (scripted answers)", () => {
  test("numbers read in their unit, and a missing rate or a simulated WhatsApp is said, never hidden", async ({ page }) => {
    await routeApi(
      page,
      shellApi({
        "metrics.summary": {
          data: {
            clockId: "GLOBAL#firm-delta",
            tab: "WORLD",
            label: "MEASURED",
            n: 3,
            kpis: [
              { key: "humanMinutesPerDossier", value: 12.5, n: 3, source: "WORLD", label: "ASSUMPTION" },
              { key: "completeBeforeArrivalPct", value: 66.7, n: 3, source: "WORLD", label: "MEASURED" },
              { key: "costPerDossierUsd", value: null, n: 3, source: "WORLD", label: "MEASURED", gap: "UNVERIFIED_RATES", detail: { missingRates: ["bedrock-input"], whatsappPricedAsLive: true } },
              { key: "policyViolations", value: 0, n: 3, source: "AUDIT_LOG", label: "MEASURED", detail: { decisionsByRule: { "CP-HOURS-SUPPLIER": { deny: 0, defer: 2 } } } },
            ],
          },
        },
      }),
    );
    await plantSession(page, "broker");
    await page.goto("/app/metrics");
    await expect(tile(page, metricsCopy.kpis.humanMinutesPerDossier)).toContainText("12,5 min");
    await expect(tile(page, metricsCopy.kpis.completeBeforeArrivalPct)).toContainText("66,7 %");
    await expect(tile(page, metricsCopy.kpis.costPerDossierUsd)).toContainText(metricsCopy.gaps.UNVERIFIED_RATES);
    await expect(tile(page, metricsCopy.kpis.costPerDossierUsd)).toContainText(metricsCopy.notes.whatsappAsLive);
    await expect(tile(page, metricsCopy.kpis.costPerDossierUsd)).toContainText(metricsCopy.notes.missingRates(1));
    await expect(page.getByRole("region", { name: metricsCopy.byRule.title }).getByRole("row", { name: /CP-HOURS-SUPPLIER/ })).toContainText("2");
    await expectNoRawCodes(page);
  });
});
