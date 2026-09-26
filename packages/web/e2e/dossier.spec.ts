// The dossier view (docs/design-brief.md §6, row 2) against the local UI server: the real `appRouter`
// over the in-memory world of Estudio Delta (operation 4471 at the start of its story: three documents
// missing, no messages yet) and the BFF's real token verifier. The flows whose procedures or seeded
// state the UI server does not have yet are declared pending, never faked with a stubbed answer.
import { expect, test } from "@playwright/test";
import { dossierCopy } from "../src/views/dossier/copy.ts";
import { controlLabel, docTypeLabel, dossierStatusLabel } from "../src/views/dossier/labels.ts";
import { dossierPath } from "../src/routes.ts";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { plantSession } from "./support/session";

const DOSSIER_4471 = dossierPath("op-4471");

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

  test.fixme("[FL-075:pending] an analyst calling dossier.approve directly gets 403 ROLE_NOT_ALLOWED, audited: needs the dossier router in the appRouter (WP-33)", async () => {});
  test.fixme("[FL-073:pending] a broker approves a dossier ready for review; with a sign-in older than 15 minutes the password prompt opens in place and the approval follows: needs dossier.approve (WP-33) and a READY_FOR_REVIEW operation in the UI server's world", async () => {});
  test.fixme("[FL-067:pending] «Tomar conversación» leaves the control with the firm and the agent paused: needs conversation.take (WP-33)", async () => {});
  test.fixme("[FL-068:pending] the firm writes free text within the importer's 24-hour window and only templates outside it: needs conversation.send (WP-33) and an importer message in the UI server's world", async () => {});
  test.fixme("[FL-043:pending] «Dispensar» with a reason leaves the observation waived and the document valid: needs dossier.waiveObservation (WP-33) and an observation in the UI server's world", async () => {});
  test.fixme("[FL-044:pending] a version the reader did not recognize is classified or discarded by the firm: needs dossier.classifyDocument (WP-33) and an UNRECOGNIZED version in the UI server's world", async () => {});
  test.fixme("[FL-042:pending] an assignment that differs from the matrix is marked for review: needs an observation flagged by assign_responsible in the UI server's world", async () => {});
  test.fixme("[FL-081:pending] every event of the timeline in sentAtSim order and a PDF only through its 5-minute link: needs messages, turn notes and versions in the UI server's world", async () => {});
});
