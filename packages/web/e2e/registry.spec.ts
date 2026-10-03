// FL-001, FL-003, FL-004, FL-006, FL-088 · registro (docs/flows-catalog.md). Against the local UI
// server, the real `registry.importers.list` and `registry.suppliers.list` show the importer with its
// masked phone and opt-in state and the supplier with its masked contact, zone, language and simulated
// behaviour. The changes (`registry.importers.upsert`, `consent.*`, `authorization.set`,
// `suppliers.upsert`, `contacts.*`, `supplierBehaviour.set`) are not registered in the `AppRouter`
// yet: the flows stay declared pending here, and scripted answers check what the forms send and how a
// refusal of the recipient fence or a duplicate reads. Nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { registryCopy } from "../src/views/registry/copy.ts";
import { type ApiCall, routeApi, shellApi } from "./support/api-route";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
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

  test.fixme("[FL-001:pending] alta de importador con opt-in: the procedures are in the AppRouter and run over the UI server's world; the spec is WP-35's", async () => {});
  test.fixme("[FL-003:pending] autorizar al agente a escribir al proveedor: the procedures are in the AppRouter and run over the UI server's world; the spec is WP-35's", async () => {});
  test.fixme("[FL-004:pending] alta de proveedor y contactos con el cerco: the procedures are in the AppRouter and run over the UI server's world; the spec is WP-35's", async () => {});
  test.fixme("[FL-006:pending] revocar opt-in o autorización: the procedures are in the AppRouter and run over the UI server's world; the spec is WP-35's", async () => {});
  test.fixme("[FL-088:pending] comportamiento del proveedor simulado: the procedures are in the AppRouter and run over the UI server's world; the spec is WP-35's", async () => {});
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
