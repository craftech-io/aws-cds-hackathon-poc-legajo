// FL-082 · isolation between firms (docs/flows-catalog.md) against the local UI server: a broker of
// Estudio Norte asks for Estudio Delta's operation, its timeline, one of its documents, its decisions
// and its world, through the console and straight to the API with its own signed token; every answer
// is a 403 with the refusal `CROSS_FIRM` and no data of Delta. A judge sees only its own world. The
// `AuditLog DENY CROSS_FIRM` the refusal writes is asserted at level U (routers/isolation.test.ts).
import { type APIRequestContext, expect, test } from "@playwright/test";
import { dataCopy } from "../src/copy/console-data.ts";
import { dossierPath } from "../src/routes.ts";
import { dossierCopy } from "../src/views/dossier/copy.ts";
import { operationsCopy } from "../src/views/operations/copy.ts";
import { blockExternalRequests, expectNoRawCodes, expectView } from "./support/assertions";
import { UI_SERVER_URL } from "./support/env";
import { type PersonaName, idTokenFor, plantSession } from "./support/session";

const DELTA_DATA = /Norpampa|Qingdao|Austral Aurora|QBT-2026-0917/;

interface Answer {
  readonly status: number;
  readonly body: string;
}

/** One tRPC query as the console would send it, with the persona's own signed id token. */
async function query(request: APIRequestContext, persona: PersonaName, procedure: string, input: unknown): Promise<Answer> {
  const url = `${UI_SERVER_URL}/api/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const response = await request.get(url, { headers: { authorization: `Bearer ${idTokenFor(persona)}` } });
  return { status: response.status(), body: await response.text() };
}

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

test.describe("[FL-082] aislamiento entre estudios", () => {
  test("[FL-082] a broker of Estudio Norte who opens Delta's operation reads a refusal in words and none of its data", async ({ page }) => {
    await plantSession(page, "otherFirm");
    await page.goto(dossierPath("op-4471"));
    await expectView(page, "dossier");
    await expect(page.getByRole("alert").filter({ hasText: dataCopy.byReason.CROSS_FIRM ?? "" })).toBeVisible();
    await expect(page.getByRole("region", { name: dossierCopy.sections.documents })).toHaveCount(0);
    expect(await page.locator("#content").innerText()).not.toMatch(DELTA_DATA);
    await expectNoRawCodes(page);

    await page.goto("/app/operations");
    await expect(page.getByText(operationsCopy.empty.title)).toBeVisible();
    expect(await page.locator("#content").innerText()).not.toMatch(DELTA_DATA);
  });

  test("[FL-082] every procedure refuses Delta's ids to Norte with 403 CROSS_FIRM and answers nothing of Delta", async ({ request }) => {
    const asked: ReadonlyArray<readonly [string, unknown]> = [
      ["operations.get", { operationId: "op-4471" }],
      ["operations.timeline", { operationId: "op-4471" }],
      ["operations.documentUrl", { docVersionId: "dv-4471-CI-1" }],
      ["audit.list", { operationId: "op-4471" }],
      ["operations.list", { clockId: "GLOBAL#firm-delta" }],
      ["escalations.list", { clockId: "GLOBAL#firm-delta" }],
      ["registry.importers.list", { clockId: "GLOBAL#firm-delta" }],
    ];
    for (const [procedure, input] of asked) {
      const answer = await query(request, "otherFirm", procedure, input);
      expect(answer.status, procedure).toBe(403);
      expect(answer.body, procedure).toContain('"reason":"CROSS_FIRM"');
      expect(answer.body, procedure).not.toMatch(DELTA_DATA);
    }
    // The same question from Delta's own broker is answered: the refusal is the fence, not the route.
    const own = await query(request, "broker", "operations.get", { operationId: "op-4471" });
    expect(own.status).toBe(200);
    expect(own.body).toContain("Norpampa Insumos SRL");
  });

  test("[FL-082] a judge sees only its own world, never Delta's operations", async ({ page }) => {
    await plantSession(page, "judge");
    await page.goto("/app/operations");
    await expect(page.getByText(operationsCopy.empty.title)).toBeVisible();
    expect(await page.locator("#content").innerText()).not.toMatch(DELTA_DATA);
  });
});
