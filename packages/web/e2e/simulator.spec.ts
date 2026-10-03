// FL-083 · simulador de teléfono (docs/flows-catalog.md). A guest who signed up alone acts as the
// importer of its own world (built from the `guest` template, so no other spec sees it) through the real
// `simulator.*` procedures: the threads of its importers, a text and a synthetic PDF of 4471, each one
// handed to the same inbound path as a real WhatsApp event. Scripted answers check
// the phone itself: labelled as a simulator, the main story's thread open by default and unread threads
// highlighted, templates with their buttons and their upload link (only ours) as WhatsApp shows them,
// the English gloss behind "EN", the ticks, "El agente está escribiendo…" during a turn, what writing,
// tapping, attaching and marking as read send to the BFF (only the importer and what it did) and the
// guest world's `QUOTA_EXCEEDED` notice. Nothing leaves the machine.
import { type APIRequestContext, type Page, type TestInfo, expect, test } from "@playwright/test";
import { createVerifiedGuest, routeCognitoToServer, testMailbox, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { quotaMessage } from "../src/views/auth/quota.ts";
import { simulatorCopy } from "../src/views/simulator/copy.ts";
import { type ApiCall, CLOCK_AT_START, routeApi, shellApi } from "./support/api-route";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { UI_SERVER_URL } from "./support/env";
import { plantSession } from "./support/session";

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

// Fixture password of the in-memory pool: it never leaves this machine.
const GUEST_PASSWORD = "Clave-de-Prueba-2026!";

/** A guest who signed up alone, in its own world built from the `guest` template, on the simulator. */
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
  await page.goto("/app/simulator");
  await expectView(page, "simulator");
}

test.describe("[FL-083] the phone of a guest's own world (the real procedures)", () => {
  test("[FL-083] opens the main story's importer and takes a text and a synthetic PDF of 4471 as the importer", async ({ page, request }, info) => {
    await ownGuestWorld(page, request, info, "sim1");
    const norpampa = phone(page);
    await expect(norpampa).toContainText(simulatorCopy.frameLabel);
    await expect(page.getByRole("navigation", { name: simulatorCopy.threads.title }).getByRole("button", { name: /Norpampa Insumos SRL/ })).toHaveAttribute("aria-current", "true");
    await expect(norpampa.getByText(/\+54\*+\d{4}/)).toBeVisible();

    await norpampa.getByLabel(simulatorCopy.composer.label).fill("¿El certificado tiene que estar firmado?");
    await norpampa.getByRole("button", { name: simulatorCopy.composer.send }).click();
    await expect(page.getByText(simulatorCopy.done.sent)).toBeVisible();
    await expect(norpampa.getByLabel(simulatorCopy.composer.label)).toHaveValue("");

    await norpampa.getByRole("button", { name: simulatorCopy.composer.attach }).click();
    await norpampa.getByLabel(simulatorCopy.attach.operation).selectOption({ label: "4471" });
    await norpampa.getByLabel(simulatorCopy.attach.docType).selectOption("PACKING_LIST");
    await norpampa.getByRole("button", { name: simulatorCopy.attach.sendSynthetic }).click();
    await expect(page.getByText(simulatorCopy.done.attached)).toBeVisible();
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });
});

const DOCS_REQUEST = {
  messageId: "msg-4471-1",
  direction: "OUT",
  operationNumber: "4471",
  kind: "DOCS_REQUEST",
  template: "legajo_docs_pendientes",
  body: "Hola, te escribimos del estudio Estudio Delta. Operación 4471, buque Austral Aurora, arribo estimado 22/10. Faltan: certificado de origen y packing list. ¿Cómo seguimos?",
  buttons: [
    { action: "UPLOAD", title: "Subir documentos", url: `${UI_SERVER_URL}/u/e2e-token`, glossEn: "Upload documents" },
    { action: "SUPPLIER_SENDS", title: "Los manda el proveedor", glossEn: "The supplier sends them" },
    { action: "QUESTION", title: "Tengo una duda", glossEn: "I have a question" },
    { action: "OPT_OUT", title: "No recibir avisos", glossEn: "Stop notices" },
  ],
  status: "READ",
  sentAtSim: "2026-10-15T10:00:30-03:00",
  glossEn: "Hi, we are writing from Estudio Delta. Operation 4471, vessel Austral Aurora, estimated arrival 22/10. Missing: certificate of origin and packing list. How do we proceed?",
};

const DEFERRED = { ...DOCS_REQUEST, messageId: "msg-4471-2", kind: "NO_ACTION_NEEDED", template: "legajo_observacion_proveedor", body: "Mensaje que todavía no salió", buttons: [], status: "DEFERRED", sentAtSim: "2026-10-16T09:00:00-03:00" };

const THREADS = {
  threads: [
    {
      importerId: "imp-patagonia",
      importerName: "Patagonia Frío SA",
      contactName: "Contacto Ficticio",
      phoneMasked: "+54*******0102",
      operations: [{ operationId: "op-4474", operationNumber: "4474" }],
      unread: 2,
      messages: [],
    },
    {
      importerId: "imp-norpampa",
      importerName: "Norpampa Insumos SRL",
      contactName: "Lucía Benítez",
      phoneMasked: "+54*******0101",
      operations: [{ operationId: "op-4471", operationNumber: "4471" }],
      unread: 0,
      messages: [DOCS_REQUEST, DEFERRED],
    },
  ],
};

async function scripted(page: Page, overrides: Parameters<typeof shellApi>[0] = {}): Promise<ApiCall[]> {
  const ok = { data: { ok: true } };
  const calls = await routeApi(
    page,
    shellApi({
      "simulator.threads": { data: THREADS },
      "simulator.sendText": ok,
      "simulator.tapButton": ok,
      "simulator.attachDocument": ok,
      "simulator.markRead": ok,
      "simulator.presignMedia": { data: { url: "http://127.0.0.1:9/s3/media-local", fields: { key: "sim/msg-1/1.pdf", "Content-Type": "application/pdf", Policy: "e2e" }, key: "sim/msg-1/1.pdf" } },
      ...overrides,
    }),
  );
  await plantSession(page, "guest");
  await page.goto("/app/simulator");
  await expectView(page, "simulator");
  return calls;
}

function phone(page: Page, importer = "Norpampa Insumos SRL") {
  return page.getByRole("region", { name: simulatorCopy.phone.title(importer) });
}

const inputOf = (calls: readonly ApiCall[], path: string) => calls.find((call) => call.path === path)?.input;

const OWN_PDF = Buffer.from("%PDF-1.4\n% synthetic test document\n%%EOF\n");

test.describe("the simulated phone (scripted answers)", () => {
  test("is labelled a simulator, opens the main story's thread and highlights the one with unread messages", async ({ page }) => {
    await scripted(page);
    const norpampa = phone(page);
    await expect(norpampa).toContainText(simulatorCopy.frameLabel);
    await expect(norpampa).toContainText(DOCS_REQUEST.body);
    await expect(norpampa.getByText(simulatorCopy.phone.template, { exact: true })).toBeVisible();
    await expect(norpampa.getByRole("link", { name: "Subir documentos" })).toHaveAttribute("href", `${UI_SERVER_URL}/u/e2e-token`);
    await expect(norpampa.getByLabel(simulatorCopy.status.READ ?? "")).toHaveText("✓✓");
    await expect(norpampa).not.toContainText(DEFERRED.body);
    const threads = page.getByRole("navigation", { name: simulatorCopy.threads.title });
    await expect(threads.getByRole("button", { name: /Patagonia Frío SA/ })).toContainText(simulatorCopy.threads.unread(2));
    await expect(threads.getByRole("button", { name: /Norpampa Insumos SRL/ })).toHaveAttribute("aria-current", "true");
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  test("shows the English gloss of a template behind 'EN'", async ({ page }) => {
    await scripted(page);
    await expect(phone(page).getByText(DOCS_REQUEST.glossEn)).toHaveCount(0);
    await phone(page).getByRole("button", { name: simulatorCopy.phone.gloss, exact: true }).click();
    await expect(phone(page).getByText(DOCS_REQUEST.glossEn)).toBeVisible();
    await expect(phone(page).getByText("[The supplier sends them]", { exact: false })).toBeVisible();
  });

  test("tapping a button sends the importer, the message and the action, never a nonce", async ({ page }) => {
    const calls = await scripted(page);
    await phone(page).getByRole("button", { name: "Los manda el proveedor" }).click();
    await expect(page.getByText(simulatorCopy.done.tapped)).toBeVisible();
    expect(inputOf(calls, "simulator.tapButton")).toEqual({ importerId: "imp-norpampa", messageId: "msg-4471-1", action: "SUPPLIER_SENDS" });
  });

  test("says the agent is writing while a turn of one of the thread's operations is running", async ({ page }) => {
    await scripted(page, { "clock.get": { data: { ...CLOCK_AT_START, busy: true, pending: [{ kind: "EVENT", operationNumber: "4471", sinceReal: new Date().toISOString() }] } } });
    await expect(phone(page).getByText(simulatorCopy.phone.typing)).toBeVisible();
    await page.getByRole("navigation", { name: simulatorCopy.threads.title }).getByRole("button", { name: /Patagonia Frío SA/ }).click();
    await expect(phone(page, "Patagonia Frío SA").getByText(simulatorCopy.phone.typing)).toHaveCount(0);
  });

  test("writing as the importer sends only the importer and the text, and marks the thread as read", async ({ page }) => {
    const calls = await scripted(page);
    await page.getByRole("navigation", { name: simulatorCopy.threads.title }).getByRole("button", { name: /Patagonia Frío SA/ }).click();
    const patagonia = phone(page, "Patagonia Frío SA");
    await patagonia.getByRole("button", { name: simulatorCopy.phone.markRead }).click();
    await expect.poll(() => inputOf(calls, "simulator.markRead")).toEqual({ importerId: "imp-patagonia" });
    await patagonia.getByLabel(simulatorCopy.composer.label).fill("¿El certificado tiene que estar firmado?");
    await patagonia.getByRole("button", { name: simulatorCopy.composer.send }).click();
    await expect(patagonia.getByLabel(simulatorCopy.composer.label)).toHaveValue("");
    expect(inputOf(calls, "simulator.sendText")).toEqual({ importerId: "imp-patagonia", text: "¿El certificado tiene que estar firmado?" });
  });

  test("attaches a synthetic PDF of the thread's operation, or uploads one of the user's own", async ({ page }) => {
    const calls = await scripted(page);
    const posted: string[] = [];
    await page.route("http://127.0.0.1:9/s3/media-local", async (route) => {
      posted.push(route.request().method());
      await route.fulfill({ status: 204 });
    });
    const norpampa = phone(page);
    await norpampa.getByRole("button", { name: simulatorCopy.composer.attach }).click();
    await norpampa.getByRole("button", { name: simulatorCopy.attach.sendSynthetic }).click();
    await expect.poll(() => inputOf(calls, "simulator.attachDocument")).toEqual({ importerId: "imp-norpampa", source: { kind: "SYNTHETIC", operationId: "op-4471", docType: "CERTIFICATE_OF_ORIGIN" } });

    await norpampa.getByLabel(simulatorCopy.attach.own).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a pdf") });
    await expect(norpampa.getByText(simulatorCopy.attach.notPdf)).toBeVisible();
    await norpampa.getByLabel(simulatorCopy.attach.own).setInputFiles({ name: "co.pdf", mimeType: "application/pdf", buffer: OWN_PDF });
    await norpampa.getByRole("button", { name: simulatorCopy.attach.sendOwn }).click();
    await expect.poll(() => calls.filter((call) => call.path === "simulator.attachDocument").at(-1)?.input).toEqual({ importerId: "imp-norpampa", source: { kind: "UPLOAD", key: "sim/msg-1/1.pdf" } });
    expect(inputOf(calls, "simulator.presignMedia")).toEqual({ importerId: "imp-norpampa", filename: "co.pdf", sizeBytes: OWN_PDF.length });
    expect(posted).toEqual(["POST"]);
  });

  test("says the simulator is off while WhatsApp runs live", async ({ page }) => {
    await scripted(page, { "simulator.threads": { error: { code: "PRECONDITION_FAILED", httpStatus: 412, reason: "WHATSAPP_LIVE" } } });
    await expect(page.getByText(simulatorCopy.liveMode)).toBeVisible();
  });

  test("an upload link that is not ours is shown as text, never as a link", async ({ page }) => {
    const foreign = { ...DOCS_REQUEST, buttons: [{ action: "UPLOAD", title: "Subir documentos", url: "https://elsewhere.example.org/u/e2e-token" }] };
    await scripted(page, { "simulator.threads": { data: { threads: [{ ...THREADS.threads[1], messages: [foreign] }] } } });
    await expect(phone(page)).toContainText(DOCS_REQUEST.body);
    await expect(phone(page).getByRole("link")).toHaveCount(0);
  });

  test("a message past the guest world's quota opens the quota notice with its renewal hour", async ({ page }) => {
    const quota = { kind: "SIMULATOR_MESSAGES", resetsAtReal: new Date(Date.UTC(2030, 0, 1, 16)).toISOString() } as const;
    const refusal = { code: "TOO_MANY_REQUESTS", httpStatus: 429, reason: "QUOTA_EXCEEDED", quota };
    await scripted(page, { "simulator.sendText": { error: refusal } });
    await phone(page).getByLabel(simulatorCopy.composer.label).fill("Hola");
    await phone(page).getByRole("button", { name: simulatorCopy.composer.send }).click();
    await expect(page.getByRole("alert").filter({ hasText: quotaMessage(AUTH_COPY.es, quota) })).toBeVisible();
    await expect(page.getByText(simulatorCopy.done.sent)).toHaveCount(0);
  });
});
