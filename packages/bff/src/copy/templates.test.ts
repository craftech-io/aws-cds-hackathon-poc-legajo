import { MessageKind, STAGE_DOMAIN, WhatsAppTemplateName } from "@legajo/shared";
import { describe, expect, it } from "vitest";
import { BUTTON_LABELS, TEMPLATE_BUTTON_MAX_CHARS } from "./buttons";
import { DISPATCH_GLOSSARY, DISPATCH_GLOSSARY_KEYS } from "./dispatch-glossary";
import { TEMPLATE_GLOSS, glossTemplate } from "./en-gloss";
import { charCount, fillPlaceholders, placeholderNumbers } from "./helpers";
import { TEMPLATES, TEMPLATE_FOR_KIND, UPLOAD_LINK_BASE_URL, isValidTemplateParam, renderTemplate, uploadLinkUrl } from "./templates";
import { looksEnglish, looksSpanish } from "./testing";

const examples = (name: WhatsAppTemplateName) => TEMPLATES[name].params.map((param) => param.example);
const hasUrlButton = (name: WhatsAppTemplateName) => TEMPLATES[name].buttons.some((button) => button.type === "URL");
const withoutPlaceholders = (body: string) => body.replace(/\{\{\d+\}\}/g, " ");

describe("WhatsApp templates (docs/architecture-integrations.md §4.3)", () => {
  it("are the eight UTILITY templates in es_AR", () => {
    expect(Object.keys(TEMPLATES)).toEqual(WhatsAppTemplateName.options);
    for (const name of WhatsAppTemplateName.options) {
      expect(TEMPLATES[name]).toMatchObject({ name, category: "UTILITY", language: "es_AR" });
    }
  });

  it("carry the message kind of docs/design-brief.md §3", () => {
    expect(TEMPLATE_FOR_KIND).toEqual({
      DOCS_REQUEST: "legajo_docs_pendientes",
      REMINDER: "legajo_recordatorio",
      NO_ACTION_NEEDED: "legajo_observacion_proveedor",
      CONTACT_REQUEST: "legajo_contacto_proveedor",
      ETA_CHANGE: "legajo_nuevo_plazo",
      ESCALATION_NOTICE: "legajo_escalado",
      APPROVAL_NOTICE: "legajo_aprobado",
      DISPATCH_STATUS: "despacho_estado",
    });
    for (const kind of Object.keys(TEMPLATE_FOR_KIND)) expect(MessageKind.options).toContain(kind);
  });

  it("never start or end with a parameter, and never put two parameters side by side", () => {
    for (const name of WhatsAppTemplateName.options) {
      const body = TEMPLATES[name].body;
      expect(body.trim(), name).not.toMatch(/^\{\{\d+\}\}|\{\{\d+\}\}$/);
      expect(body, name).not.toMatch(/\}\}\s*\{\{/);
    }
  });

  it("number their parameters 1..n, once each and in order, with one sample per parameter", () => {
    for (const name of WhatsAppTemplateName.options) {
      const numbers = placeholderNumbers(TEMPLATES[name].body);
      expect(numbers, name).toEqual(numbers.map((_, index) => index + 1));
      expect(TEMPLATES[name].params, name).toHaveLength(numbers.length);
      for (const param of TEMPLATES[name].params) expect(isValidTemplateParam(param.example), `${name}.${param.name}`).toBe(true);
    }
  });

  it("have the buttons of the design, each within 25 characters and titled from buttons.ts", () => {
    const actions = Object.fromEntries(WhatsAppTemplateName.options.map((name) => [name, TEMPLATES[name].buttons.map((button) => button.action)]));
    expect(actions).toEqual({
      legajo_docs_pendientes: ["UPLOAD", "SUPPLIER_SENDS", "QUESTION", "OPT_OUT"],
      legajo_recordatorio: ["UPLOAD", "SUPPLIER_SENDS", "QUESTION"],
      legajo_observacion_proveedor: ["QUESTION"],
      legajo_contacto_proveedor: ["OTHER_CONTACT", "TALK_TO_FIRM"],
      legajo_nuevo_plazo: ["QUESTION"],
      legajo_escalado: [],
      legajo_aprobado: [],
      despacho_estado: ["TALK_TO_FIRM"],
    });
    for (const name of WhatsAppTemplateName.options) {
      for (const button of TEMPLATES[name].buttons) {
        expect(charCount(button.text), `${name}.${button.action}`).toBeLessThanOrEqual(TEMPLATE_BUTTON_MAX_CHARS);
        expect(button.text).toBe(BUTTON_LABELS[button.action].template);
        if (button.type === "URL") expect(button.url).toBe(`https://${STAGE_DOMAIN}/u/{{1}}`);
      }
    }
  });

  it("render the story's first request with the upload link", () => {
    const rendered = renderTemplate("legajo_docs_pendientes", examples("legajo_docs_pendientes"), "tok_4471");
    expect(rendered.body).toBe(
      "Hola, te escribimos del estudio Estudio Delta. Operación 4471, buque Austral Aurora, arribo estimado 22/10. Faltan: certificado de origen y packing list. ¿Cómo seguimos?",
    );
    expect(rendered.buttons[0]).toEqual({ type: "URL", action: "UPLOAD", text: "Subir documentos", url: `${UPLOAD_LINK_BASE_URL}tok_4471` });
    expect(rendered.buttons.map((button) => button.text)).toEqual(["Subir documentos", "Los manda el proveedor", "Tengo una duda", "No recibir avisos"]);
  });

  it("fill despacho_estado from every glossary entry", () => {
    for (const key of DISPATCH_GLOSSARY_KEYS) {
      const { statusText, explanation } = DISPATCH_GLOSSARY[key];
      const body = renderTemplate("despacho_estado", ["4471", statusText, explanation]).body;
      expect(body).toBe(`Operación 4471: ${statusText}. ${explanation} Ante cualquier duda, consultá con el estudio.`);
    }
  });

  it("refuse a wrong arity, an invalid parameter or a wrong upload token", () => {
    expect(() => renderTemplate("legajo_aprobado", [])).toThrow(RangeError);
    expect(() => renderTemplate("legajo_aprobado", ["4471", "extra"])).toThrow(RangeError);
    expect(() => renderTemplate("legajo_escalado", ["4471", "Estudio\nDelta"])).toThrow(RangeError);
    expect(() => renderTemplate("legajo_escalado", ["4471", "   "])).toThrow(RangeError);
    expect(() => renderTemplate("legajo_recordatorio", examples("legajo_recordatorio"))).toThrow(RangeError);
    expect(() => renderTemplate("legajo_aprobado", ["4471"], "tok")).toThrow(RangeError);
    expect(isValidTemplateParam("a     b")).toBe(false);
    expect(() => fillPlaceholders("{{1}} y {{3}}", ["a", "b"])).toThrow(RangeError);
  });

  it("encode the upload token in the link", () => {
    expect(uploadLinkUrl("a/b")).toBe(`${UPLOAD_LINK_BASE_URL}a%2Fb`);
  });

  it("are Spanish, and each has an English gloss with the same parameters", () => {
    for (const name of WhatsAppTemplateName.options) {
      expect(looksSpanish(withoutPlaceholders(TEMPLATES[name].body)), name).toBe(true);
      expect(looksEnglish(withoutPlaceholders(TEMPLATE_GLOSS[name])), name).toBe(true);
      expect(placeholderNumbers(TEMPLATE_GLOSS[name]), name).toEqual(placeholderNumbers(TEMPLATES[name].body));
      expect(glossTemplate(name, examples(name))).not.toMatch(/\{\{/);
      if (hasUrlButton(name)) expect(TEMPLATES[name].buttons[0]?.type).toBe("URL");
    }
    expect(glossTemplate("legajo_aprobado", ["4471"])).toBe("Operation 4471: the firm approved the dossier. We will tell you about the customs dispatch here.");
  });
});
