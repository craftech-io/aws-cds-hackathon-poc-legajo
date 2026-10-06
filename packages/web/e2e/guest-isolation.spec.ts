// FL-123 · a guest works only on synthetic data of its own guest firm (docs/flows-catalog.md; ADR-0015
// §4 "Solo datos sintéticos") against the local UI server, in every project of the public surfaces:
// two visitors sign up, each gets its own world from the seed's `guest` template (same story, ids of
// its own slot), and neither reaches the other's world, a demo firm's or one its token does not name.
//
//   (a) another firm's ids, through the console and straight to the API with the guest's own token:
//       403 `CROSS_FIRM`, nothing of the other world, nothing changed in it; a token whose firm is not a
//       guest firm is refused before any procedure runs (the principal is incomplete)
//   (b) the guest world's registry takes only simulated mailboxes and phones of its slot's block:
//       403 `RECIPIENT_NOT_ALLOWED`
//   (c) what the guest sees of its own parties is synthetic: masked phones, simulated mailboxes,
//       "ficticio", and no screen carries a word of ADR-0014
//
// The audit rows of each refusal are asserted at level U (packages/bff/src/routers/guest-isolation.test.ts).
import { Buffer } from "node:buffer";
import { type APIRequestContext, type Page, type TestInfo, expect, test } from "@playwright/test";
import { findNeutralHits } from "../../../scripts/lint/neutral-words.ts";
import { createVerifiedGuest, inLang, routeCognitoToServer, specLang, testMailbox, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { dataCopy } from "../src/copy/console-data.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { dossierCopy } from "../src/views/dossier/copy.ts";
import { controlLabel } from "../src/views/dossier/labels.ts";
import { operationsCopy } from "../src/views/operations/copy.ts";
import { blockExternalRequests } from "./support/assertions";
import { followProjectLanguage } from "./support/console-lang";
import { UI_SERVER_URL } from "./support/env";
import { signJwt } from "./support/keys";
import { TOKENS_KEY } from "./support/session";

followProjectLanguage();

// Fixture password of the in-memory user pool: it never leaves this machine.
const PASSWORD = "Clave-de-Prueba-2026!";
const SIM_DOMAIN = "@sim.legajo.demo.craftech.io";
const DEMO_DOMAIN = "legajo.demo.craftech.io";

interface Answer {
  readonly status: number;
  readonly body: string;
}

interface Guest {
  readonly idToken: string;
  /** Operation 4471 of this guest's own world (`op-4471-g<nn>`). */
  readonly operationId: string;
}

/** One tRPC call as the console sends it, with `idToken` in the console's header. */
async function call(request: APIRequestContext, idToken: string, procedure: string, input: unknown, kind: "query" | "mutation" = "query"): Promise<Answer> {
  const headers = { "x-legajo-auth": `Bearer ${idToken}` };
  const response =
    kind === "query"
      ? await request.get(`${UI_SERVER_URL}/api/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers })
      : await request.post(`${UI_SERVER_URL}/api/${procedure}`, { headers: { ...headers, "content-type": "application/json" }, data: input });
  return { status: response.status(), body: await response.text() };
}

async function prepare(page: Page, info: TestInfo): Promise<string[]> {
  const blocked = await blockExternalRequests(page);
  await routeCognitoToServer(page, UI_SERVER_URL);
  await useViewerIp(page, testViewerIp(info));
  return blocked;
}

/** A visitor who signed up and verified its email, signed in, with its world ready and the console open. */
async function signInGuest(page: Page, request: APIRequestContext, info: TestInfo, key: string): Promise<Guest> {
  const lang = specLang(info);
  const t = AUTH_COPY[lang];
  const email = testMailbox(info, key);
  await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
  await page.goto(inLang("/login", lang));
  await page.getByLabel(t.login.login).fill(email);
  await page.getByLabel(t.login.password, { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: t.login.submit }).click();
  await expect(page).toHaveURL(/\/app\/operations/, { timeout: 20_000 });
  const href = await page.getByRole("link", { name: operationsCopy.openDossier("4471") }).first().getAttribute("href");
  const operationId = /\/app\/operations\/(op-4471-g\d+)$/.exec(href ?? "")?.[1];
  const raw = await page.evaluate((storageKey) => window.sessionStorage.getItem(storageKey), TOKENS_KEY);
  const idToken = (JSON.parse(raw ?? "{}") as { idToken?: string }).idToken;
  if (operationId === undefined || idToken === undefined) throw new Error("the guest's console did not open on its own world");
  return { idToken, operationId };
}

function expectNeutral(text: string): void {
  expect(findNeutralHits(text)).toEqual([]);
}

let blocked: string[] = [];

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

test.describe("[FL-123] un invitado opera solo sobre datos sintéticos y su propio estudio", () => {
  test("[FL-123] (a) another guest's world and a demo firm's are refused with 403, through the console and the API, and nothing of them changes", async ({ page, browser, request }, info) => {
    blocked = await prepare(page, info);
    const otherPage = await browser.newPage();
    const otherBlocked = await prepare(otherPage, info);
    const other = await signInGuest(otherPage, request, info, "iso-b");
    const own = await signInGuest(page, request, info, "iso-a");
    expect(own.operationId).not.toBe(other.operationId);

    // The console: the other guest's dossier is a refusal in words, with none of its sections.
    await page.goto(`/app/operations/${other.operationId}`);
    await expect(page.getByRole("alert").filter({ hasText: dataCopy.byReason.CROSS_FIRM ?? "" })).toBeVisible();
    await expect(page.getByRole("region", { name: dossierCopy.sections.documents })).toHaveCount(0);
    expectNeutral(await page.locator("body").innerText());

    // The API with the guest's own token: every id of another world is 403 CROSS_FIRM.
    const otherWorld = await call(request, other.idToken, "operations.get", { operationId: other.operationId });
    const otherClock = /"clockId":"([^"]+)"/.exec(otherWorld.body)?.[1];
    expect(otherClock).toMatch(/^GUEST#firm-guest-/);
    const asked: ReadonlyArray<readonly [string, unknown, "query" | "mutation"]> = [
      ["operations.get", { operationId: other.operationId }, "query"],
      ["operations.timeline", { operationId: other.operationId }, "query"],
      ["clock.get", { clockId: otherClock }, "query"],
      ["registry.importers.list", { clockId: otherClock }, "query"],
      ["operations.get", { operationId: "op-4471" }, "query"],
      ["operations.list", { clockId: "GLOBAL#firm-delta" }, "query"],
      ["conversation.take", { operationId: other.operationId }, "mutation"],
      ["conversation.take", { operationId: "op-4471" }, "mutation"],
    ];
    for (const [procedure, input, kind] of asked) {
      const answer = await call(request, own.idToken, procedure, input, kind);
      expect(answer.status, `${procedure} ${JSON.stringify(input)}`).toBe(403);
      expect(answer.body, procedure).toContain('"reason":"CROSS_FIRM"');
      expect(answer.body, procedure).not.toMatch(/"operationId"|Norpampa|Qingdao/);
    }
    // The other guest's conversation is still the agent's: the refused take changed nothing.
    expect((await call(request, other.idToken, "operations.get", { operationId: other.operationId })).body).toContain('"control":"AGENT"');

    // A token that says GUEST but names a firm that is not a guest firm never reaches a procedure.
    const claims = JSON.parse(Buffer.from(own.idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = signJwt({ ...claims, "custom:firmId": "firm-delta" });
    const refused = await call(request, forged, "operations.list", {});
    expect(refused.status).toBeGreaterThanOrEqual(401);
    expect(refused.status).toBeLessThanOrEqual(403);
    expect(refused.body).not.toMatch(/"operationId"|Norpampa/);

    expect(otherBlocked).toEqual([]);
    await otherPage.close();
  });

  test("[FL-123] (b) the guest world's registry takes only simulated mailboxes and phones of its slot's block", async ({ page, request }, info) => {
    blocked = await prepare(page, info);
    const own = await signInGuest(page, request, info, "iso-reg");
    const supplier = { name: "Harborline Packaging Ltd.", country: "GB", timezone: "Europe/London", language: "en" };
    const importer = { name: "Litoral Envases SA", contactName: "Rocío Paz", contactFirstName: "Rocío", language: "es" };
    const attempts: ReadonlyArray<readonly [string, unknown]> = [
      ["registry.suppliers.upsert", { ...supplier, contacts: ["ventas@example.com"] }],
      ["registry.importers.upsert", { ...importer, phoneE164: "+14155550101" }],
      ["registry.importers.upsert", { ...importer, phoneE164: "+5491155500150" }],
    ];
    for (const [procedure, input] of attempts) {
      const answer = await call(request, own.idToken, procedure, input, "mutation");
      expect(answer.status, procedure).toBe(403);
      expect(answer.body, procedure).toMatch(/"reason":"(RECIPIENT_NOT_ALLOWED|GUEST_SYNTHETIC_ONLY)"/);
    }
    const suppliers = await call(request, own.idToken, "registry.suppliers.list", {});
    expect(suppliers.status).toBe(200);
    expect(suppliers.body).not.toContain("Harborline");
  });

  test("[FL-123] (c) what the guest sees of its own world is synthetic, and acting on it reaches only that world", async ({ page, request }, info) => {
    blocked = await prepare(page, info);
    const own = await signInGuest(page, request, info, "iso-own");
    expectNeutral(await page.locator("body").innerText());

    await page.goto(`/app/operations/${own.operationId}`);
    const summary = page.getByRole("region", { name: dossierCopy.sections.summary });
    await expect(summary).toContainText(dossierCopy.parties.fictitious);
    await expect(summary).toContainText(SIM_DOMAIN);
    await expect(summary).toContainText(/\+54\*+\d{4}/);
    expect(await summary.innerText()).not.toMatch(/\+54 ?9? ?11 ?\d{4} ?\d{4}/);
    expectNeutral(await page.locator("body").innerText());

    // Taking the conversation changes this guest's own operation, and only through its own token.
    await page.getByRole("button", { name: dossierCopy.conversation.take }).click();
    await expect(summary).toContainText(controlLabel.BROKER);
    const read = await call(request, own.idToken, "operations.get", { operationId: own.operationId });
    expect(read.body).toContain('"control":"BROKER"');
    // Every address it reads is a simulated mailbox, masked, or the operation's own address of the demo.
    for (const email of read.body.match(/[\w.*+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []) expect(email.endsWith(DEMO_DOMAIN), email.replace(/^[^@]*/, "…")).toBe(true);
  });
});
