// The dossier view (docs/design-brief.md §6, row 2) against the local UI server: the real `appRouter`
// over the in-memory world of Estudio Delta (operation 4471 at the start of its story: three documents
// missing, no messages yet) and the BFF's real token verifier. The firm's actions (FL-042..FL-044,
// FL-067, FL-068, FL-073) and the timeline (FL-081) run in the world of a guest who signs up for the
// spec (the seed's `guest` template, built by the real world factory, its clock paused on 14/10 10:30):
// 4488 ready for review, 4478 with its history of messages, each test in a world of its own, so no
// change of one reaches another spec. Nothing is answered by a stub: every call reaches the real router.
import { Buffer } from "node:buffer";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { createVerifiedGuest, routeCognitoToServer, testMailbox, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { TEST_PREFIX } from "../../../tests/ui-server/auth/routes.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { dossierCopy } from "../src/views/dossier/copy.ts";
import { controlLabel, docStatusLabel, docTypeLabel, dossierStatusLabel, observationStatusLabel, timerTitle } from "../src/views/dossier/labels.ts";
import { escalationsCopy } from "../src/views/escalations/copy.ts";
import { operationsCopy } from "../src/views/operations/copy.ts";
import { dossierPath } from "../src/routes.ts";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { UI_SERVER_URL } from "./support/env";
import { signJwt } from "./support/keys";
import { TOKENS_KEY, idTokenFor, plantSession } from "./support/session";

const DOSSIER_4471 = dossierPath("op-4471");
// Fixture password of the in-memory user pool: it never leaves this machine.
const PASSWORD = "Clave-de-Prueba-2026!";
const AUTH = AUTH_COPY.es;

/** A guest that signed up and verified its email, signed in: its own world is ready and the console open. */
async function signInFreshGuest(page: Page, request: APIRequestContext, key: string): Promise<string> {
  const email = testMailbox(test.info(), key);
  await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
  await routeCognitoToServer(page, UI_SERVER_URL);
  await useViewerIp(page, testViewerIp(test.info()));
  await page.goto("/login");
  await page.getByLabel(AUTH.login.login).fill(email);
  await page.getByLabel(AUTH.login.password, { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: AUTH.login.submit }).click();
  await expect(page).toHaveURL(/\/app\/operations/, { timeout: 20_000 });
  return email;
}

/** Opens the dossier of `number` from the list of operations, as a person would. */
async function openFromList(page: Page, number: string): Promise<void> {
  await page.goto("/app/operations");
  await page.getByRole("link", { name: operationsCopy.openDossier(number) }).first().click();
  await expectView(page, "dossier");
  await expect(page.getByText(new RegExp(`^Operación ${number} · `))).toBeVisible();
}

/** The session's id token re-signed with an interactive sign-in `minutes` old (the rest of its claims kept). */
async function ageSignIn(page: Page, minutes: number): Promise<void> {
  const raw = await page.evaluate((key) => window.sessionStorage.getItem(key), TOKENS_KEY);
  const tokens = JSON.parse(raw ?? "{}") as { idToken: string };
  const claims = JSON.parse(Buffer.from(tokens.idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const idToken = signJwt({ ...claims, iat: now, exp: now + 900, auth_time: now - minutes * 60 });
  await page.evaluate(({ key, value }) => window.sessionStorage.setItem(key, value), { key: TOKENS_KEY, value: JSON.stringify({ ...tokens, idToken, expiresAt: Date.now() + 900_000 }) });
  await page.reload();
}

function region(page: Page, name: string) {
  return page.getByRole("region", { name });
}

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

test.describe("detalle del legajo", () => {
  test("the dossier of 4471 shows its three documents, the parties masked and fictitious, the risk with its assumption, no pendings and an empty timeline", async ({ page }) => {
    await plantSession(page, "analyst");
    await page.goto(DOSSIER_4471);
    await expectView(page, "dossier");
    await expect(page.getByText(dossierCopy.heading("4471", "Norpampa Insumos SRL", "Qingdao Bluewave Textiles Co., Ltd."))).toBeVisible();

    const documents = page.getByRole("region", { name: dossierCopy.sections.documents });
    for (const docType of ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] as const) {
      const block = documents.getByRole("article", { name: docTypeLabel[docType] });
      await expect(block).toContainText("Faltante");
      await expect(block).toContainText(dossierCopy.documents.noVersions);
      await expect(block).toContainText(dossierCopy.documents.noObservations);
    }

    const summary = page.getByRole("region", { name: dossierCopy.sections.summary });
    await expect(summary).toContainText("jue 22/10 08:00");
    await expect(summary).toContainText(dossierStatusLabel.OPEN);
    await expect(summary).toContainText(controlLabel.AGENT);
    await expect(summary).toContainText("+54*******0101");
    await expect(summary).toContainText("s***@sim.legajo.demo.craftech.io");
    await expect(summary).toContainText(dossierCopy.parties.fictitious);
    await expect(summary).toContainText(dossierCopy.risk.assumptionLabel);
    await expect(summary).toContainText("QBT-2026-0917 · FOB Qingdao");

    await expect(page.getByRole("region", { name: dossierCopy.sections.pending })).toContainText(dossierCopy.pending.empty);
    await expect(page.getByRole("region", { name: dossierCopy.sections.timeline })).toContainText(dossierCopy.timeline.empty);

    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/5550 ?0101|supplier-qingdao@|s3Key|sha256/);
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  test("the section bar jumps to every block without hiding the others", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto(DOSSIER_4471);
    const nav = page.getByRole("navigation", { name: dossierCopy.sections.nav });
    await nav.getByRole("button", { name: dossierCopy.sections.timeline }).click();
    await expect(page.getByRole("region", { name: dossierCopy.sections.timeline })).toBeInViewport();
    await expect(page.getByRole("region", { name: dossierCopy.sections.documents })).toBeAttached();
  });

  test("a link that names no operation says so and calls nothing", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/[^?]*operations\.get/.test(request.url())) calls.push(request.url());
    });
    await plantSession(page, "broker");
    await page.goto("/app/operations/not-an-operation");
    await expect(page.getByText(dossierCopy.notFound.title)).toBeVisible();
    expect(calls).toEqual([]);
  });
});

test.describe("acciones del legajo", () => {
  test("an analyst never sees «Aprobar legajo» nor «Reabrir», and may take the conversation", async ({ page }) => {
    await plantSession(page, "analyst");
    await page.goto(DOSSIER_4471);
    await expect(page.getByRole("button", { name: dossierCopy.conversation.take })).toBeVisible();
    await expect(page.getByText(dossierCopy.conversation.takeHint)).toBeVisible();
    await expect(page.getByRole("button", { name: dossierCopy.approval.approve })).toHaveCount(0);
    await expect(page.getByRole("button", { name: dossierCopy.reopen.open })).toHaveCount(0);
  });

  test("a broker sees «Aprobar legajo» closed, with its reason, until the dossier is ready for review", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto(DOSSIER_4471);
    const approve = page.getByRole("button", { name: dossierCopy.approval.approve });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAccessibleDescription(dossierCopy.approval.notReady);
    await expect(page.getByRole("button", { name: dossierCopy.reopen.open })).toHaveCount(0);
  });
});

test.describe("[FL-075] un analista no puede aprobar", () => {
  test("[FL-075] an analyst calling dossier.approve directly gets 403 ROLE_NOT_ALLOWED and the dossier does not change", async ({ request }) => {
    const headers = { "x-legajo-auth": `Bearer ${idTokenFor("analyst")}`, "content-type": "application/json" };
    const answer = await request.post(`${UI_SERVER_URL}/api/dossier.approve`, { headers, data: { operationId: "op-4471" } });
    expect(answer.status()).toBe(403);
    expect(await answer.text()).toContain('"reason":"ROLE_NOT_ALLOWED"');
    const read = await request.get(`${UI_SERVER_URL}/api/operations.get?input=${encodeURIComponent(JSON.stringify({ operationId: "op-4471" }))}`, { headers });
    expect(read.status()).toBe(200);
    expect(await read.text()).toContain('"dossierStatus":"OPEN"');
  });
});

test.describe("acciones del estudio en su propio mundo", () => {
  test("[FL-073] a guest approves 4488, ready for review; with a sign-in older than 15 minutes the password prompt opens in place and the approval follows", async ({ page, request }) => {
    await signInFreshGuest(page, request, "fl073");
    await openFromList(page, "4488");
    const url = page.url();
    await expect(region(page, dossierCopy.sections.summary)).toContainText(dossierStatusLabel.READY_FOR_REVIEW);
    await ageSignIn(page, 20);

    await page.getByRole("button", { name: dossierCopy.approval.approve }).click();
    const prompt = page.getByRole("dialog", { name: AUTH.prompts.stepUp.title });
    await expect(prompt).toBeVisible();
    expect(page.url()).toBe(url);
    await prompt.getByLabel(AUTH.login.password, { exact: true }).fill(PASSWORD);
    await prompt.getByRole("button", { name: AUTH.login.submit }).click();
    await expect(prompt.getByText(AUTH.prompts.stepUp.done)).toBeVisible();
    await prompt.getByRole("button", { name: AUTH.prompts.close }).first().click();

    const review = page.getByRole("dialog", { name: dossierCopy.approval.title });
    await expect(review).toBeVisible();
    for (const docType of ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] as const) await expect(review).toContainText(docTypeLabel[docType]);
    await expect(review).toContainText(observationStatusLabel.RESOLVED);
    await review.getByRole("button", { name: dossierCopy.approval.submit, exact: true }).click();
    await expect(page.getByText(dossierCopy.approval.done)).toBeVisible();
    await expect(region(page, dossierCopy.sections.summary)).toContainText(dossierStatusLabel.APPROVED);
    await expect(page.getByRole("button", { name: dossierCopy.reopen.open })).toBeVisible();
    expect(page.url()).toBe(url);
    await expectNoRawCodes(page);
  });

  test("[FL-067] «Tomar conversación» leaves the control with the firm and the agent paused; «Devolver al agente» gives it back", async ({ page, request }) => {
    await signInFreshGuest(page, request, "fl067");
    await openFromList(page, "4471");
    const summary = region(page, dossierCopy.sections.summary);
    await expect(summary).toContainText(controlLabel.AGENT);
    await page.getByRole("button", { name: dossierCopy.conversation.take }).click();
    await expect(page.getByRole("button", { name: dossierCopy.conversation.release })).toBeVisible();
    await expect(page.getByRole("button", { name: dossierCopy.conversation.write })).toBeVisible();
    await expect(page.getByText(dossierCopy.conversation.takeHint)).toHaveCount(0);
    await expect(summary).toContainText(controlLabel.BROKER);

    await page.getByRole("button", { name: dossierCopy.conversation.release }).click();
    await expect(page.getByRole("button", { name: dossierCopy.conversation.take })).toBeVisible();
    await expect(summary).toContainText(controlLabel.AGENT);
    await expectAccessibleBasics(page);
  });

  test("[FL-068] the firm writes free text within the importer's 24-hour window and only templates outside it", async ({ page, request }) => {
    await signInFreshGuest(page, request, "fl068");
    const text = dossierCopy.conversation;

    // 4488: the importer wrote on 13/10 at 16:30, 18 hours before the world's 14/10 10:30.
    await openFromList(page, "4488");
    await page.getByRole("button", { name: text.take }).click();
    await page.getByRole("button", { name: text.write }).click();
    let composer = page.getByRole("dialog", { name: text.title });
    await expect(composer.getByText(text.windowClosed)).toHaveCount(0);
    await composer.getByLabel(text.text).fill("Hola, soy del estudio: revisamos el packing list corregido y está todo en orden.");
    await composer.getByRole("button", { name: text.send }).click();
    await expect(composer.getByText(text.sent)).toBeVisible();
    await page.keyboard.press("Escape");

    // 4478: its importer's last message is from 13/10 09:15, more than 24 hours ago: templates only.
    await openFromList(page, "4478");
    await page.getByRole("button", { name: text.take }).click();
    await page.getByRole("button", { name: text.write }).click();
    composer = page.getByRole("dialog", { name: text.title });
    await expect(composer.getByText(text.windowClosed)).toBeVisible();
    await expect(composer.getByLabel(text.text)).toHaveCount(0);
    await composer.getByLabel(text.template).selectOption({ label: text.templates.legajo_recordatorio });
    await composer.getByRole("button", { name: text.send }).click();
    await expect(composer.getByText(text.sent)).toBeVisible();
    await expectNoRawCodes(page);
  });

  test("[FL-081] every event of the timeline in sentAtSim order, and a PDF only through its 5-minute link", async ({ page, request }) => {
    await signInFreshGuest(page, request, "fl081");
    await openFromList(page, "4478");
    const timeline = region(page, dossierCopy.sections.timeline);
    // The importer's answers, as stored (the first one is also the title of a button it tapped).
    await expect(timeline.getByRole("paragraph").filter({ hasText: /^Los manda el proveedor$/ })).toBeVisible();
    await expect(timeline.getByRole("paragraph").filter({ hasText: /^Sí, escribile$/ })).toBeVisible();
    const instants = await timeline.locator("ol > li > time").evaluateAll((nodes) => nodes.map((node) => Date.parse(node.getAttribute("datetime") ?? "")));
    expect(instants.length).toBeGreaterThanOrEqual(7);
    expect(instants.every((at) => Number.isFinite(at))).toBe(true);
    expect(instants).toEqual([...instants].sort((a, b) => a - b));

    await openFromList(page, "4488");
    const links: string[] = [];
    page.on("request", (sent) => {
      if (sent.url().includes("operations.documentUrl")) links.push(sent.url());
    });
    await page.route("**/s3/**", (route) => route.fulfill({ status: 200, contentType: "application/pdf", headers: { "content-disposition": "attachment" }, body: "%PDF-1.4\n%synthetic\n" }));
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: dossierCopy.documents.downloadLabel(docTypeLabel.PACKING_LIST, 2) }).click();
    expect(new URL((await download).url()).pathname).toMatch(/^\/s3\//);
    expect(links).toHaveLength(1);
    await expect(page.locator("iframe, embed, object, a[href*='/s3/']")).toHaveCount(0);
    expect(page.url()).toContain("/app/operations/");
  });
});

test.describe("pendientes con motivo", () => {
  test("«Avanzar hasta ahí» moves the paused clock exactly to the pending, which is then due", async ({ page, request }) => {
    await signInFreshGuest(page, request, "advance");
    await openFromList(page, "4471");
    const pending = region(page, dossierCopy.sections.pending);
    const first = pending.getByRole("listitem").first();
    await expect(first).toContainText(timerTitle("MILESTONE", "DOCS_REQUEST"));
    await expect(first).toContainText("jue 15/10 10:00");
    const advance = first.getByRole("button", { name: dossierCopy.pending.advanceLabel(timerTitle("MILESTONE", "DOCS_REQUEST"), "jue 15/10 10:00") });
    await expect(advance).toHaveText(dossierCopy.pending.advance);
    await advance.click();

    const raw = await page.evaluate((key) => window.sessionStorage.getItem(key), TOKENS_KEY);
    const headers = { "x-legajo-auth": `Bearer ${(JSON.parse(raw ?? "{}") as { idToken?: string }).idToken ?? ""}` };
    await expect
      .poll(async () => {
        const answer = await request.get(`${UI_SERVER_URL}/api/clock.get?input=${encodeURIComponent("{}")}`, { headers });
        return Date.parse(/"simNow":"([^"]+)"/.exec(await answer.text())?.[1] ?? "");
      })
      .toBe(Date.parse("2026-10-15T10:00:00-03:00"));
    // The UI server has no worker to run the milestone: it stays due, without a move left to make.
    const due = pending.getByRole("listitem").filter({ hasText: timerTitle("MILESTONE", "DOCS_REQUEST") });
    await expect(due.getByRole("button")).toHaveCount(0);
    await expect(due).toContainText(dossierCopy.pending.due);
  });
});

test.describe("observaciones y documentos no reconocidos", () => {
  /** Readings of the guest's world the UI server has no worker to produce (tests/ui-server test route). */
  async function withReadings(page: Page, request: APIRequestContext, key: string): Promise<void> {
    const email = await signInFreshGuest(page, request, key);
    const answer = await request.post(`${UI_SERVER_URL}${TEST_PREFIX}dossier-fixtures`, { data: { email } });
    expect(answer.status(), "the UI server's dossier fixtures").toBe(200);
  }

  test("[FL-042] an assignment that differs from the matrix is marked for review", async ({ page, request }) => {
    await withReadings(page, request, "fl042");
    await openFromList(page, "4474");
    const packingList = region(page, dossierCopy.sections.documents).getByRole("article", { name: docTypeLabel.PACKING_LIST });
    await expect(packingList).toContainText(docStatusLabel.WITH_OBSERVATION);
    await expect(packingList.getByText(dossierCopy.documents.matrixDiffers)).toBeVisible();
    await expectNoRawCodes(page);
  });

  test("[FL-043] «Dispensar» with a reason leaves the observation waived and the document valid", async ({ page, request }) => {
    await withReadings(page, request, "fl043");
    await openFromList(page, "4474");
    const packingList = region(page, dossierCopy.sections.documents).getByRole("article", { name: docTypeLabel.PACKING_LIST });
    await packingList.getByRole("button", { name: dossierCopy.documents.waive }).click();
    const drawer = page.getByRole("dialog", { name: dossierCopy.waive.title });
    await drawer.getByRole("button", { name: dossierCopy.waive.submit }).click();
    await expect(drawer.getByText(dossierCopy.reasonRequired)).toBeVisible();
    await drawer.getByLabel(dossierCopy.waive.reason).fill("Diferencia de bultos aceptada por el estudio");
    await drawer.getByRole("button", { name: dossierCopy.waive.submit }).click();
    await expect(packingList).toContainText(observationStatusLabel.WAIVED_BY_BROKER);
    await expect(packingList).toContainText(dossierCopy.documents.waivedBecause("Diferencia de bultos aceptada por el estudio"));
    await expect(packingList).toContainText(docStatusLabel.VALID);
  });

  test("[FL-044] a version the reader did not recognize is classified by the firm and its escalation resolved", async ({ page, request }) => {
    await withReadings(page, request, "fl044");
    await page.goto("/app/escalations");
    await expect(page.getByText(escalationsCopy.empty.title)).toHaveCount(0);
    await openFromList(page, "4477");
    const certificate = region(page, dossierCopy.sections.documents).getByRole("article", { name: docTypeLabel.CERTIFICATE_OF_ORIGIN });
    await expect(certificate.getByText(dossierCopy.documents.unrecognized(1))).toBeVisible();
    await certificate.getByRole("button", { name: dossierCopy.documents.classify }).click();
    const drawer = page.getByRole("dialog", { name: dossierCopy.classify.title });
    await drawer.getByLabel(dossierCopy.classify.docType).selectOption({ label: docTypeLabel.CERTIFICATE_OF_ORIGIN });
    await drawer.getByRole("button", { name: dossierCopy.classify.submit, exact: true }).click();
    await expect(certificate.getByText(dossierCopy.documents.unrecognized(1))).toHaveCount(0);
    await expect(certificate).toContainText(docStatusLabel.VALID);
    await page.goto("/app/escalations");
    await expect(page.getByText(escalationsCopy.empty.title)).toBeVisible();
  });
});
