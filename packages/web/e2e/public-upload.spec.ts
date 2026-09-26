// FL-009 and FL-010 · the importer's upload page `/u/<token>` (docs/flows-catalog.md) in a real browser,
// against the back half of the local UI server (tests/ui-server/app.ts: the real PublicWeb handler,
// its page script and the S3 emulator that takes a pre-signed POST only as S3 would). Each test runs
// that back half in its own process (scripts/landing/local-server.ts) so it can write the upload link
// `create_upload_link` would write and read back what the page left for DocumentIntake. The browser
// uploads with the real fetch/XMLHttpRequest of the page; nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { MAX_DOCUMENT_BYTES } from "@legajo/bff/domain/documents";
import { confirmationPending, documentLabel, uploadPageEsAR } from "@legajo/bff/public-web/copy";
import { UPLOAD_MARK, markId } from "@legajo/bff/public-web/links";
import type { DocType } from "@legajo/shared";
import { type LocalServer, newToken, newUploadLink, startLocalServer, syntheticPdf } from "../../../scripts/landing/local-server";
import { LOCAL_BUCKETS } from "../../../tests/ui-server/app";
import { blockExternalRequests } from "./support/assertions";

const texts = uploadPageEsAR;
let server: LocalServer;
let blocked: string[];
let presigns: string[];

test.beforeEach(async ({ page }) => {
  server = await startLocalServer();
  blocked = await blockExternalRequests(page);
  presigns = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/presign")) presigns.push(request.url());
  });
});

test.afterEach(async () => {
  await server.close();
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

function documentItem(page: Page, docType: DocType) {
  return page.getByRole("listitem").filter({ hasText: documentLabel(docType) });
}

async function choose(page: Page, docType: DocType, file: { readonly name: string; readonly mimeType: string; readonly buffer: Buffer }): Promise<void> {
  await page.getByLabel(documentLabel(docType), { exact: true }).setInputFiles(file);
}

function uploadedKeys(): string[] {
  return server.app.objects.keys(LOCAL_BUCKETS.uploads);
}

async function uploadActions(operationId: string): Promise<string[]> {
  const trail = await server.app.stores.connector.audit.listByOperation(operationId);
  return trail.filter((decision) => decision.action.startsWith("UPLOAD_")).map((decision) => `${decision.decision} ${decision.action}`);
}

interface StorageAttempt {
  readonly base: string;
  readonly docType: string;
  readonly contentType: string;
  readonly bytes: number;
}

/**
 * Runs in the page: what a client that skips the page's own checks would do with a valid link. It
 * asks for the pre-signed POST and sends the file straight to storage with the page's `fetch`.
 */
async function postToStorage({ base, docType, contentType, bytes }: StorageAttempt): Promise<{ presign: number; storage: number }> {
  const presign = await fetch(`${base}/presign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ docType }) });
  if (presign.status !== 200) return { presign: presign.status, storage: 0 };
  const post = (await presign.json()) as { url: string; fields: Record<string, string> };
  const form = new FormData();
  for (const [name, value] of Object.entries(post.fields)) form.append(name, name === "Content-Type" ? contentType : value);
  const body = new Uint8Array(bytes);
  body.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  form.append("file", new Blob([body], { type: contentType }));
  const answer = await fetch(post.url, { method: "POST", body: form });
  return { presign: presign.status, storage: answer.status };
}

test.describe("[FL-009] carga por link: PDF reconocido", () => {
  test("[FL-009] the page shows the operation and what is missing, sends the PDF straight to storage and confirms it", async ({ page }) => {
    const link = await newUploadLink(server.app);
    const storagePosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().startsWith(`${server.origin}/s3/`)) storagePosts.push(request.url());
    });
    const response = await page.goto(`${server.origin}/u/${link.token}`);
    expect(response?.status()).toBe(200);
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"]).toContain(`connect-src 'self' ${server.origin}`);
    expect(headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(headers).toMatchObject({ "x-frame-options": "DENY", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });

    await expect(page.getByRole("heading", { level: 1, name: texts.heading("4471") })).toBeVisible();
    for (const docType of link.docTypes) await expect(documentItem(page, docType)).toBeVisible();
    // The operation number and the documents, nothing about the parties.
    expect(await page.locator("body").innerText()).not.toMatch(/Norpampa|Qingdao|Lucía|Delta|@/);
    await expect(page.getByRole("button", { name: texts.doneButton })).toBeDisabled();

    const pdf = syntheticPdf(48_213);
    await choose(page, "CERTIFICATE_OF_ORIGIN", { name: "certificado.pdf", mimeType: "application/pdf", buffer: pdf });
    await expect(documentItem(page, "CERTIFICATE_OF_ORIGIN").getByRole("status")).toHaveText(texts.script.uploaded);
    const keys = uploadedKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^uploads/${link.token}/CERTIFICATE_OF_ORIGIN/[0-9a-f-]{36}\\.pdf$`));
    const stored = server.app.objects.get(LOCAL_BUCKETS.uploads, keys[0] ?? "");
    expect(stored?.contentType).toBe("application/pdf");
    expect(Buffer.from(stored?.body ?? new Uint8Array()).equals(pdf)).toBe(true);
    expect(storagePosts).toEqual([`${server.origin}/s3/${LOCAL_BUCKETS.uploads}`]);

    await page.getByRole("button", { name: texts.doneButton }).click();
    await expect(page.getByRole("heading", { name: texts.confirmationHeading })).toBeVisible();
    await expect(page.getByText(confirmationPending(["PACKING_LIST"]))).toBeVisible();

    // What the page leaves for DocumentIntake: the document confirmed for this link and the object waiting for its scan.
    const connector = server.app.stores.connector;
    expect(await connector.runtime.getIdempotency(UPLOAD_MARK.doc, markId.doc(link.token, "CERTIFICATE_OF_ORIGIN"))).toBeDefined();
    expect((await connector.world.listPending(link.clockId)).scans.map((scan) => scan.objectKey)).toEqual(keys);
    expect((await uploadActions(link.operationId)).sort()).toEqual(["ACTION UPLOAD_LINK_OPENED", "ACTION UPLOAD_PRESIGNED", "ACTION UPLOAD_SESSION_DONE"]);

    // Back on the same link, the page asks only for what is still missing.
    await page.goto(`${server.origin}/u/${link.token}`);
    await expect(documentItem(page, "PACKING_LIST")).toBeVisible();
    await expect(documentItem(page, "CERTIFICATE_OF_ORIGIN")).toHaveCount(0);
  });

  test("[FL-009] uploading every requested document completes the link, which then opens as used", async ({ page }) => {
    const link = await newUploadLink(server.app);
    await page.goto(`${server.origin}/u/${link.token}`);
    await choose(page, "CERTIFICATE_OF_ORIGIN", { name: "certificado.pdf", mimeType: "application/pdf", buffer: syntheticPdf(20_000) });
    await choose(page, "PACKING_LIST", { name: "packing-list.pdf", mimeType: "application/pdf", buffer: syntheticPdf(30_000) });
    for (const docType of link.docTypes) await expect(documentItem(page, docType).getByRole("status")).toHaveText(texts.script.uploaded);
    await page.getByRole("button", { name: texts.doneButton }).click();
    await expect(page.getByText(confirmationPending([]))).toBeVisible();
    expect(uploadedKeys()).toHaveLength(2);
    expect((await server.app.stores.connector.runtime.getUploadLink(link.token))?.completedAtReal).toBeDefined();

    const again = await page.goto(`${server.origin}/u/${link.token}`);
    expect(again?.status()).toBe(410);
    await expect(page.getByRole("heading", { level: 1, name: texts.errors.used.title })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain("4471");
  });
});

test.describe("[FL-010] carga por link rechazada", () => {
  test("[FL-010] a file that is not a PDF is refused by the page, and by storage when a client skips the page", async ({ page }) => {
    const link = await newUploadLink(server.app);
    await page.goto(`${server.origin}/u/${link.token}`);
    await choose(page, "PACKING_LIST", { name: "packing-list.html", mimeType: "text/html", buffer: Buffer.from("<html><body>not a pdf</body></html>") });
    await expect(documentItem(page, "PACKING_LIST").getByRole("status")).toHaveText(texts.script.notPdf);
    await expect(page.getByRole("button", { name: texts.doneButton })).toBeDisabled();
    expect(presigns).toEqual([]);

    // The link's own pre-signed POST, with another type: the policy only takes application/pdf.
    expect(await page.evaluate(postToStorage, { base: `/u/${link.token}`, docType: "PACKING_LIST", contentType: "text/html", bytes: 64 })).toEqual({ presign: 200, storage: 403 });
    expect(uploadedKeys()).toEqual([]);
  });

  test("[FL-010] a PDF over 10 MB is refused by the page, and by storage when a client skips the page", async ({ page }) => {
    const link = await newUploadLink(server.app);
    await page.goto(`${server.origin}/u/${link.token}`);
    await choose(page, "PACKING_LIST", { name: "packing-list.pdf", mimeType: "application/pdf", buffer: syntheticPdf(MAX_DOCUMENT_BYTES + 1) });
    await expect(documentItem(page, "PACKING_LIST").getByRole("status")).toHaveText(texts.script.tooLarge);
    expect(presigns).toEqual([]);

    // content-length-range 1..10 MB of the policy.
    expect(await page.evaluate(postToStorage, { base: `/u/${link.token}`, docType: "PACKING_LIST", contentType: "application/pdf", bytes: MAX_DOCUMENT_BYTES + 1 })).toEqual({ presign: 200, storage: 400 });
    expect(uploadedKeys()).toEqual([]);
  });

  test("[FL-010] an expired link and an unknown one open an error page without any data, and the expiry is recorded once", async ({ page }) => {
    const expired = await newUploadLink(server.app, { expiresAtReal: new Date(Date.now() - 60_000) });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await page.goto(`${server.origin}/u/${expired.token}`);
      expect(response?.status()).toBe(410);
      expect(response?.headers()["content-security-policy"]).not.toContain("script-src");
    }
    await expect(page.getByRole("heading", { level: 1, name: texts.errors.expired.title })).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("4471");
    for (const docType of expired.docTypes) expect(text).not.toContain(documentLabel(docType));
    expect(await uploadActions(expired.operationId)).toEqual(["DENY UPLOAD_LINK_EXPIRED"]);

    const unknown = await page.goto(`${server.origin}/u/${newToken()}`);
    expect(unknown?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: texts.errors.notFound.title })).toBeVisible();
    expect(uploadedKeys()).toEqual([]);
  });
});
