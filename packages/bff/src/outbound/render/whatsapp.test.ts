// The WhatsApp a send becomes (docs/tool-catalog.md `send_whatsapp`; FL-007): an approved template
// filled in order, its quick replies as nonces bound to the importer and the operation, its URL button
// with the upload token; free text with reply buttons whose titles the code writes; and the shapes the
// transports would refuse, refused first.
import { beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "@legajo/shared";
import { memoryStores } from "../../connector/testing";
import type { MemoryStores } from "../../connector/memory/index";
import { BUTTON_LABELS } from "../../copy/buttons";
import { checkWhatsAppShape, needsUploadLink, renderWhatsApp, templateActions, type WhatsAppRenderInput } from "./whatsapp";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const PARAMS = ["Estudio Delta", "4471", "Austral Aurora", "22/10", "certificado de origen y packing list"];

let stores: MemoryStores;

beforeEach(() => {
  stores = memoryStores();
});

function input(overrides: Partial<WhatsAppRenderInput> = {}): WhatsAppRenderInput {
  return {
    messageId: "msg-render0001",
    to: "+5491155500101",
    nonceKey: "test-nonce-subkey-0123456789abcdef0123456789",
    operationId: "op-4471",
    importerId: "imp-norpampa",
    phoneHash: "a".repeat(64),
    clockId: "GLOBAL#firm-delta",
    now: new Date("2026-09-26T15:00:00.000Z"),
    ...overrides,
  };
}

describe("[FL-007] the documents request template", () => {
  it("fills the body in order, issues one nonce per quick reply and puts the token in the URL button", async () => {
    const rendered = await renderWhatsApp(stores.connector.runtime, input({ template: { name: "legajo_docs_pendientes", params: PARAMS }, uploadToken: TOKEN }));
    expect(rendered.body).toBe("Hola, te escribimos desde Estudio Delta. Operación 4471, buque Austral Aurora, arribo estimado 22/10. Faltan: certificado de origen y packing list. ¿Cómo seguimos?");
    expect(rendered.buttons.map((button) => button.action)).toEqual(["UPLOAD", "SUPPLIER_SENDS", "QUESTION", "OPT_OUT"]);
    expect(rendered.buttons[0]).toMatchObject({ url: `https://legajo.demo.craftech.io/u/${TOKEN}` });
    expect(rendered.buttons[0]?.nonce).toBeUndefined();
    const nonces = rendered.buttons.slice(1).map((button) => button.nonce);
    expect(new Set(nonces).size).toBe(3);
    for (const nonce of nonces) expect(await stores.connector.runtime.getNonce(nonce ?? "")).toMatchObject({ operationId: "op-4471", importerId: "imp-norpampa", messageId: "msg-render0001" });
    expect(rendered.message).toMatchObject({ type: "template", to: "5491155500101", template: { name: "legajo_docs_pendientes", language: { code: "es_AR" } } });
    expect(JSON.stringify(rendered.message)).toContain(TOKEN);
  });

  it("rendering the same message again issues the same nonces", async () => {
    const template = { name: "legajo_docs_pendientes" as const, params: PARAMS };
    const first = await renderWhatsApp(stores.connector.runtime, input({ template, uploadToken: TOKEN }));
    const again = await renderWhatsApp(stores.connector.runtime, input({ template, uploadToken: TOKEN }));
    expect(again.buttons).toEqual(first.buttons);
  });

  it("knows which templates need an upload link and their fixed buttons", () => {
    expect(needsUploadLink("legajo_docs_pendientes")).toBe(true);
    expect(needsUploadLink("legajo_escalado")).toBe(false);
    expect(templateActions("legajo_contacto_proveedor")).toEqual(["OTHER_CONTACT", "TALK_TO_FIRM"]);
  });
});

describe("free text with reply buttons", () => {
  it("becomes an interactive message whose titles come from copy/", async () => {
    const payload = { supplierId: "sup-qingdao", contactId: "ctc-qingdao-2" };
    const rendered = await renderWhatsApp(stores.connector.runtime, input({ text: "¿Le escribimos a tu proveedor a s***@sim.legajo.demo.craftech.io?", buttons: [{ action: "CONFIRM_CONTACT", payload }, { action: "REJECT_CONTACT", payload }] }));
    expect(rendered.buttons.map((button) => button.title)).toEqual([BUTTON_LABELS.CONFIRM_CONTACT.interactive, BUTTON_LABELS.REJECT_CONTACT.interactive]);
    expect(rendered.message).toMatchObject({ type: "interactive" });
    expect(await stores.connector.runtime.getNonce(rendered.buttons[0]?.nonce ?? "")).toMatchObject({ action: "CONFIRM_CONTACT", payload });
  });

  it("plain text has no buttons, and a text past WhatsApp's limits is INVALID", async () => {
    expect(await renderWhatsApp(stores.connector.runtime, input({ text: "Llegaron los documentos." }))).toMatchObject({ body: "Llegaron los documentos.", buttons: [], message: { type: "text" } });
    await expect(renderWhatsApp(stores.connector.runtime, input({ text: "x".repeat(5000) }))).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("the shape is checked before anything is issued", () => {
  const refused = (shape: Parameters<typeof checkWhatsAppShape>[0], kind: string) => {
    try {
      checkWhatsAppShape(shape, kind);
      return undefined;
    } catch (error) {
      return error instanceof ToolError ? error.message : String(error);
    }
  };

  it("exactly one of text or template, the template of the kind, its parameters and its own buttons", () => {
    expect(refused({}, "REPLY")).toBe("send either a text or a template");
    expect(refused({ text: "Hola", template: { name: "legajo_escalado", params: ["4471", "Estudio Delta"] } }, "REPLY")).toBe("send either a text or a template");
    expect(refused({ template: { name: "legajo_escalado", params: ["4471", "Estudio Delta"] } }, "REPLY")).toBe("template legajo_escalado carries ESCALATION_NOTICE, not REPLY");
    expect(refused({ template: { name: "legajo_escalado", params: ["4471"] } }, "ESCALATION_NOTICE")).toBe("template legajo_escalado takes 2 parameters in this order: operationNumber, firmName; got 1");
    expect(refused({ template: { name: "legajo_contacto_proveedor", params: ["4471", "Qingdao"] }, buttons: [{ action: "UPLOAD" }] }, "CONTACT_REQUEST")).toContain("are fixed");
    expect(refused({ template: { name: "legajo_escalado", params: ["4471", "Estudio Delta"] } }, "ESCALATION_NOTICE")).toBeUndefined();
  });

  it("at most three distinct reply buttons on a text", () => {
    expect(refused({ text: "Hola", buttons: [{ action: "QUESTION" }, { action: "QUESTION" }] }, "REPLY")).toBe("a button action appears twice");
    expect(refused({ text: "Hola", buttons: [{ action: "QUESTION" }, { action: "UPLOAD" }, { action: "OPT_OUT" }, { action: "TALK_TO_FIRM" }] }, "REPLY")).toBe("at most 3 buttons");
  });
});
