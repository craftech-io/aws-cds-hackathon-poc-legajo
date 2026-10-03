// FL-001, FL-003, FL-004, FL-006, FL-088 · registro (docs/flows-catalog.md). Against the local UI
// server, the real `registry.importers.list` and `registry.suppliers.list` show the importer with its
// masked phone and opt-in state and the supplier with its masked contact, zone, language and simulated
// behaviour. A guest who signed up alone then changes its own world (built from the `guest` template,
// so no other spec sees it) through the real procedures: a new importer with a phone of the world's
// block and its opt-in, an authorization granted and taken back, the opt-in revoked, a supplier with a
// simulated mailbox and the simulated behaviour, and the refusals of anything that is not synthetic.
// Scripted answers check what each form sends and how a duplicate reads. Nothing leaves the machine.
import { type APIRequestContext, type Page, type TestInfo, expect, test } from "@playwright/test";
import { createVerifiedGuest, routeCognitoToServer, testMailbox, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { BEHAVIOUR_LABELS, registryCopy } from "../src/views/registry/copy.ts";
import { type ApiCall, routeApi, shellApi } from "./support/api-route";
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

function importers(page: Page) {
  return page.getByRole("region", { name: registryCopy.importers.title, exact: true });
}

function suppliers(page: Page) {
  return page.getByRole("region", { name: registryCopy.suppliers.title, exact: true });
}

function drawer(page: Page) {
  return page.getByRole("dialog");
}

test.describe("registro against the real lists", () => {
  test("lists the importer with its masked phone and opt-in, and the supplier with its masked contact and behaviour", async ({ page }) => {
    await plantSession(page, "analyst");
    await page.goto("/app/registry");
    await expectView(page, "registry");
    const norpampa = importers(page).getByRole("row", { name: /Norpampa Insumos SRL/ });
    await expect(norpampa).toContainText("+54*******0101");
    await expect(norpampa).toContainText(registryCopy.consent.none);
    await expect(norpampa).toContainText(registryCopy.importers.noAuthorizations);
    const qingdao = suppliers(page).getByRole("row", { name: /Qingdao Bluewave Textiles/ });
    await expect(qingdao).toContainText("s***@sim.legajo.demo.craftech.io");
    await expect(qingdao).toContainText("Activo");
    await expect(qingdao).toContainText("Asia/Shanghai");
    await expect(qingdao).toContainText("Primero con un error sembrado, después corregido");
    await expect(page.getByText("+5491155500101")).toHaveCount(0);
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  test("another firm sees none of Estudio Delta's parties", async ({ page }) => {
    await plantSession(page, "otherFirm");
    await page.goto("/app/registry");
    await expectView(page, "registry");
    await expect(importers(page)).toContainText(registryCopy.importers.empty);
    await expect(suppliers(page)).toContainText(registryCopy.suppliers.empty);
  });

});

// Fixture password of the in-memory pool: it never leaves this machine.
const GUEST_PASSWORD = "Clave-de-Prueba-2026!";

/** A guest who signed up alone, in its own world built from the `guest` template, on the registry. */
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
  await page.goto("/app/registry");
  await expectView(page, "registry");
}

/** A fictitious phone of the world's own block (`+54 9 11 5551 <nn>xx`), read from a seeded importer's masked one. */
async function phoneOfThisWorld(page: Page, last: string): Promise<string> {
  const masked = await importers(page).getByRole("row", { name: /Norpampa Insumos SRL/ }).getByText(/\+54\*+\d{4}/).innerText();
  const block = /(\d{2})\d{2}$/.exec(masked.trim())?.[1] ?? "";
  return `+549115551${block}${last}`;
}

test.describe("registro of a guest's own world (the real procedures)", () => {
  test("[FL-001] a new importer with a phone of the world's block, then its WhatsApp opt-in; a phone outside the block is refused", async ({ page, request }, info) => {
    await ownGuestWorld(page, request, info, "reg1");
    await importers(page).getByRole("button", { name: registryCopy.importers.add }).click();
    const form = drawer(page);
    await form.getByLabel(registryCopy.importerForm.name).fill("Importadora Ficticia del Sur SRL");
    await form.getByLabel(registryCopy.importerForm.contactName).fill("Carla Ficticia");
    await form.getByLabel(registryCopy.importerForm.contactFirstName).fill("Carla");
    await form.getByLabel(registryCopy.importerForm.phone).fill("+5491155500199");
    await form.getByRole("button", { name: registryCopy.importerForm.submit }).click();
    await expect(form.getByText(registryCopy.reasons.GUEST_SYNTHETIC_ONLY ?? "")).toBeVisible();

    const phone = await phoneOfThisWorld(page, "97");
    await form.getByLabel(registryCopy.importerForm.phone).fill(phone);
    await form.getByRole("button", { name: registryCopy.importerForm.submit }).click();
    await expect(form.getByText(registryCopy.importerForm.saved)).toBeVisible();
    await form.getByRole("button", { name: registryCopy.forms.close }).first().click();

    const row = importers(page).getByRole("row", { name: /Importadora Ficticia del Sur SRL/ });
    await expect(row).toContainText(phone.slice(-4));
    await expect(row).toContainText(registryCopy.consent.none);
    await expect(page.getByText(phone)).toHaveCount(0);

    await row.getByRole("button", { name: registryCopy.importers.consentAction }).click();
    await drawer(page).getByLabel(registryCopy.consent.medium).selectOption({ label: "Formulario firmado" });
    await drawer(page).getByRole("button", { name: registryCopy.consent.record }).click();
    await expect(drawer(page).getByText(registryCopy.consent.recorded)).toBeVisible();
    await drawer(page).getByRole("button", { name: registryCopy.forms.close }).first().click();
    await expect(row).toContainText(/Vigente desde .* · Formulario firmado · texto v1/);
    await expectNoRawCodes(page);
  });

  test("[FL-003] [FL-006] the agent is authorized to write to the importer's supplier, then the authorization and the opt-in are revoked", async ({ page, request }, info) => {
    await ownGuestWorld(page, request, info, "reg2");
    const norpampa = importers(page).getByRole("row", { name: /Norpampa Insumos SRL/ });
    await norpampa.getByRole("button", { name: registryCopy.importers.authorize }).click();
    const panel = drawer(page);
    // A supplier of the world that Norpampa has not authorized yet in the `guest` template.
    const supplier = "Elbhafen Tools GmbH";
    await panel.getByTitle(registryCopy.authorization.grant(supplier)).click();
    await expect(panel.getByText(registryCopy.authorization.saved)).toBeVisible();
    await expect(panel.getByTitle(registryCopy.authorization.revoke(supplier))).toBeVisible();
    await panel.getByRole("button", { name: registryCopy.forms.close }).first().click();
    await expect(norpampa).toContainText(supplier);

    await norpampa.getByRole("button", { name: registryCopy.importers.authorize }).click();
    await drawer(page).getByTitle(registryCopy.authorization.revoke(supplier)).click();
    await expect(drawer(page).getByText(registryCopy.authorization.saved)).toBeVisible();
    await drawer(page).getByRole("button", { name: registryCopy.forms.close }).first().click();
    await expect(norpampa).not.toContainText(supplier);

    await expect(norpampa).toContainText(/Vigente desde/);
    await norpampa.getByRole("button", { name: registryCopy.importers.consentAction }).click();
    await drawer(page).getByLabel(registryCopy.consent.reason).fill("Pidió no recibir avisos");
    await drawer(page).getByRole("button", { name: registryCopy.consent.revoke }).click();
    await expect(drawer(page).getByText(registryCopy.consent.revoked_)).toBeVisible();
    await drawer(page).getByRole("button", { name: registryCopy.forms.close }).first().click();
    await expect(norpampa).toContainText(/Revocado el/);
  });

  test("[FL-004] [FL-088] a supplier with a simulated mailbox is saved active and one outside the fence is refused; the simulated behaviour changes", async ({ page, request }, info) => {
    await ownGuestWorld(page, request, info, "reg3");
    await suppliers(page).getByRole("button", { name: registryCopy.suppliers.add }).click();
    const form = drawer(page);
    await form.getByLabel(registryCopy.supplierForm.name).fill("Proveedor Ficticio Ibérico SL");
    await form.getByLabel(registryCopy.supplierForm.country).fill("ES");
    await form.getByLabel(registryCopy.supplierForm.timezone).fill("Europe/Madrid");
    await form.getByLabel(registryCopy.supplierForm.contacts).fill("ventas@proveedor-ficticio.test");
    await form.getByRole("button", { name: registryCopy.supplierForm.submit }).click();
    await expect(form.getByText(registryCopy.reasons.GUEST_SYNTHETIC_ONLY ?? "")).toBeVisible();

    const mailbox = `iberico-${info.workerIndex}-${Date.now().toString(36)}@sim.legajo.demo.craftech.io`;
    await form.getByLabel(registryCopy.supplierForm.contacts).fill(mailbox);
    await form.getByRole("button", { name: registryCopy.supplierForm.submit }).click();
    await expect(form.getByText(registryCopy.supplierForm.saved)).toBeVisible();
    await form.getByRole("button", { name: registryCopy.forms.close }).first().click();
    const iberico = suppliers(page).getByRole("row", { name: /Proveedor Ficticio Ibérico SL/ });
    await expect(iberico).toContainText("Europe/Madrid");
    await expect(iberico).toContainText("Activo");
    await expect(page.getByText(mailbox)).toHaveCount(0);

    const qingdao = suppliers(page).getByRole("row", { name: /Qingdao Bluewave Textiles/ });
    await qingdao.getByRole("button", { name: registryCopy.suppliers.setBehaviour }).click();
    await drawer(page).getByLabel(registryCopy.behaviourForm.behaviour).selectOption("LATE");
    await drawer(page).getByRole("button", { name: registryCopy.behaviourForm.submit }).click();
    await expect(drawer(page).getByText(registryCopy.behaviourForm.saved)).toBeVisible();
    await drawer(page).getByRole("button", { name: registryCopy.forms.close }).first().click();
    await expect(qingdao).toContainText(BEHAVIOUR_LABELS.LATE);
    await expectNoRawCodes(page);
  });
});

const IMPORTERS = {
  clockId: "GLOBAL#firm-delta",
  importers: [
    {
      importerId: "imp-norpampa",
      name: "Norpampa Insumos SRL",
      contactName: "Lucía Benítez",
      phoneMasked: "+54*******0101",
      language: "es",
      consent: { status: "GRANTED", grantedAt: "2026-09-30T12:00:00-03:00", medium: "SIGNED_FORM", textVersion: "v1" },
      authorizations: [],
    },
    { importerId: "imp-litoral", name: "Litoral Hogar SA", contactName: "Contacto Ficticio", phoneMasked: "+54*******0103", language: "es", consent: { status: "NONE" }, authorizations: [] },
  ],
};

const SUPPLIERS = {
  clockId: "GLOBAL#firm-delta",
  suppliers: [
    {
      supplierId: "sup-qingdao",
      name: "Qingdao Bluewave Textiles Co., Ltd.",
      country: "CN",
      timezone: "Asia/Shanghai",
      language: "en",
      behaviour: "PROMPT",
      contacts: [
        { contactId: "ctc-qingdao-1", emailMasked: "s***@sim.legajo.demo.craftech.io", status: "ACTIVE", confirmedBy: "SEED" },
        { contactId: "ctc-qingdao-2", emailMasked: "o***@sim.legajo.demo.craftech.io", status: "PENDING_CONFIRMATION" },
      ],
    },
  ],
};

const OPERATIONS = { clockId: "GLOBAL#firm-delta", operations: [{ operationId: "op-4471", operationNumber: "4471", supplierId: "sup-qingdao", importerId: "imp-norpampa" }] };

async function scripted(page: Page, overrides: Parameters<typeof shellApi>[0] = {}): Promise<ApiCall[]> {
  const ok = { data: { ok: true } };
  const calls = await routeApi(
    page,
    shellApi({
      "registry.importers.list": { data: IMPORTERS },
      "registry.suppliers.list": { data: SUPPLIERS },
      "operations.list": { data: OPERATIONS },
      "registry.importers.upsert": { data: { importerId: "imp-nueva" } },
      "registry.consent.record": ok,
      "registry.consent.revoke": ok,
      "registry.authorization.set": ok,
      "registry.contacts.confirm": ok,
      "registry.supplierBehaviour.set": ok,
      ...overrides,
    }),
  );
  await plantSession(page, "analyst");
  await page.goto("/app/registry");
  await expectView(page, "registry");
  return calls;
}

const inputOf = (calls: readonly ApiCall[], path: string) => calls.find((call) => call.path === path)?.input;

test.describe("registro forms (scripted answers)", () => {
  test("a new importer is sent with its phone in international format, and the lists reload", async ({ page }) => {
    const calls = await scripted(page);
    await importers(page).getByRole("button", { name: registryCopy.importers.add }).click();
    const form = drawer(page);
    await form.getByLabel(registryCopy.importerForm.name).fill("Importadora Ficticia SRL");
    await form.getByLabel(registryCopy.importerForm.contactName).fill("Carla Ficticia");
    await form.getByLabel(registryCopy.importerForm.contactFirstName).fill("Carla");
    await form.getByLabel(registryCopy.importerForm.phone).fill("011 5550-0199");
    await form.getByRole("button", { name: registryCopy.importerForm.submit }).click();
    await expect(form.getByText(registryCopy.importerForm.phoneInvalid)).toBeVisible();
    expect(inputOf(calls, "registry.importers.upsert")).toBeUndefined();

    await form.getByLabel(registryCopy.importerForm.phone).fill("+5491155500199");
    await form.getByRole("button", { name: registryCopy.importerForm.submit }).click();
    await expect(form.getByText(registryCopy.importerForm.saved)).toBeVisible();
    expect(inputOf(calls, "registry.importers.upsert")).toEqual({ name: "Importadora Ficticia SRL", contactName: "Carla Ficticia", contactFirstName: "Carla", phoneE164: "+5491155500199", language: "es" });
    expect(calls.filter((call) => call.path === "registry.importers.list").length).toBeGreaterThan(1);
  });

  test("an opt-in is registered with medium, date and text version; one in force is revoked", async ({ page }) => {
    const calls = await scripted(page);
    await importers(page).getByRole("row", { name: /Litoral Hogar/ }).getByRole("button", { name: registryCopy.importers.consentAction }).click();
    await drawer(page).getByLabel(registryCopy.consent.medium).selectOption({ label: "Email" });
    await drawer(page).getByRole("button", { name: registryCopy.consent.record }).click();
    await expect(drawer(page).getByText(registryCopy.consent.recorded)).toBeVisible();
    expect(inputOf(calls, "registry.consent.record")).toEqual({ importerId: "imp-litoral", medium: "EMAIL", grantedAt: "2026-10-14T10:30:00-03:00", textVersion: "v1" });

    await drawer(page).getByRole("button", { name: registryCopy.forms.close }).first().click();
    await importers(page).getByRole("row", { name: /Norpampa/ }).getByRole("button", { name: registryCopy.importers.consentAction }).click();
    await drawer(page).getByLabel(registryCopy.consent.reason).fill("Pidió no recibir avisos");
    await drawer(page).getByRole("button", { name: registryCopy.consent.revoke }).click();
    await expect(drawer(page).getByText(registryCopy.consent.revoked_)).toBeVisible();
    expect(inputOf(calls, "registry.consent.revoke")).toEqual({ importerId: "imp-norpampa", reason: "Pidió no recibir avisos" });
  });

  test("the agent is authorized to write to the importer's supplier", async ({ page }) => {
    const calls = await scripted(page);
    await importers(page).getByRole("row", { name: /Norpampa/ }).getByRole("button", { name: registryCopy.importers.authorize }).click();
    await drawer(page).getByRole("button", { name: registryCopy.authorization.grantShort }).click();
    await expect(drawer(page).getByText(registryCopy.authorization.saved)).toBeVisible();
    expect(inputOf(calls, "registry.authorization.set")).toEqual({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true });
  });

  test("a supplier contact outside the recipient fence or already taken is refused in the form", async ({ page }) => {
    let answer = 0;
    await scripted(page, {
      "registry.suppliers.upsert": () =>
        ++answer === 1 ? { error: { code: "FORBIDDEN", httpStatus: 403, reason: "RECIPIENT_NOT_ALLOWED" } } : { error: { code: "CONFLICT", httpStatus: 409, reason: "CONFLICT" } },
    });
    await suppliers(page).getByRole("button", { name: registryCopy.suppliers.add }).click();
    const form = drawer(page);
    await form.getByLabel(registryCopy.supplierForm.name).fill("Proveedor Ficticio SL");
    await form.getByLabel(registryCopy.supplierForm.country).fill("es");
    await form.getByLabel(registryCopy.supplierForm.timezone).fill("Europe/Nowhere");
    await form.getByLabel(registryCopy.supplierForm.contacts).fill("ventas@proveedor-ficticio.test");
    await form.getByRole("button", { name: registryCopy.supplierForm.submit }).click();
    await expect(form.getByText(registryCopy.supplierForm.timezoneInvalid)).toBeVisible();

    await form.getByLabel(registryCopy.supplierForm.timezone).fill("Europe/Madrid");
    await form.getByRole("button", { name: registryCopy.supplierForm.submit }).click();
    await expect(form.getByText(registryCopy.reasons.RECIPIENT_NOT_ALLOWED ?? "")).toBeVisible();
    await form.getByRole("button", { name: registryCopy.supplierForm.submit }).click();
    await expect(form.getByText(registryCopy.reasons.CONFLICT ?? "")).toBeVisible();
  });

  test("a pending contact is confirmed from its row, and the simulated behaviour is set for one operation", async ({ page }) => {
    const calls = await scripted(page);
    await suppliers(page).getByRole("button", { name: registryCopy.suppliers.confirm }).click();
    await expect(suppliers(page).getByText(registryCopy.suppliers.confirmed)).toBeVisible();
    expect(inputOf(calls, "registry.contacts.confirm")).toEqual({ contactId: "ctc-qingdao-2" });

    await suppliers(page).getByRole("button", { name: registryCopy.suppliers.setBehaviour }).click();
    await drawer(page).getByLabel(registryCopy.behaviourForm.behaviour).selectOption("SEEDED_ERROR_TWICE");
    await drawer(page).getByLabel(registryCopy.behaviourForm.scope).selectOption({ label: registryCopy.behaviourForm.operation("4471") });
    await drawer(page).getByRole("button", { name: registryCopy.behaviourForm.submit }).click();
    await expect(drawer(page).getByText(registryCopy.behaviourForm.saved)).toBeVisible();
    expect(inputOf(calls, "registry.supplierBehaviour.set")).toEqual({ supplierId: "sup-qingdao", behaviour: "SEEDED_ERROR_TWICE", operationId: "op-4471" });
    await expectNoRawCodes(page);
  });
});
