// The eight `UTILITY` WhatsApp templates in `es_AR` (docs/architecture-integrations.md §4.3). The seed
// writes them to `Reference/TEMPLATE#WHATSAPP`, `scripts/channels/whatsapp-templates.ts` registers
// them with Meta, and the WhatsApp render fills them; the simulated transport renders them exactly as
// the live one would. Meta rules the tests enforce: no body starts or ends with a parameter, no two
// parameters touch, buttons are ≤ 25 characters, parameters carry no line breaks or tabs.
import { STAGE_DOMAIN, WhatsAppTemplateName, type MessageKind } from "@legajo/shared";
import { BUTTON_LABELS } from "./buttons";
import { fillPlaceholders } from "./helpers";
import type { TemplateButton, TemplateParam } from "./types";

export const WHATSAPP_TEMPLATE_CATEGORY = "UTILITY";
export const WHATSAPP_TEMPLATE_LANGUAGE = "es_AR";

/** Base of the upload link (`/u/<token>`, served by `PublicWeb`); the token is the URL button's parameter. */
export const UPLOAD_LINK_BASE_URL = `https://${STAGE_DOMAIN}/u/`;

export function uploadLinkUrl(token: string): string {
  return `${UPLOAD_LINK_BASE_URL}${encodeURIComponent(token)}`;
}

export interface TemplateDefinition {
  readonly name: WhatsAppTemplateName;
  /** Message kind this template carries (docs/design-brief.md §3). */
  readonly kind: MessageKind;
  readonly category: typeof WHATSAPP_TEMPLATE_CATEGORY;
  readonly language: typeof WHATSAPP_TEMPLATE_LANGUAGE;
  readonly body: string;
  readonly params: readonly TemplateParam[];
  readonly buttons: readonly TemplateButton[];
}

const uploadButton: TemplateButton = { type: "URL", action: "UPLOAD", text: BUTTON_LABELS.UPLOAD.template, url: `${UPLOAD_LINK_BASE_URL}{{1}}` };
const supplierSendsButton: TemplateButton = { type: "QUICK_REPLY", action: "SUPPLIER_SENDS", text: BUTTON_LABELS.SUPPLIER_SENDS.template };
const questionButton: TemplateButton = { type: "QUICK_REPLY", action: "QUESTION", text: BUTTON_LABELS.QUESTION.template };
const optOutButton: TemplateButton = { type: "QUICK_REPLY", action: "OPT_OUT", text: BUTTON_LABELS.OPT_OUT.template };
const otherContactButton: TemplateButton = { type: "QUICK_REPLY", action: "OTHER_CONTACT", text: BUTTON_LABELS.OTHER_CONTACT.template };
const talkToFirmButton: TemplateButton = { type: "QUICK_REPLY", action: "TALK_TO_FIRM", text: BUTTON_LABELS.TALK_TO_FIRM.template };

const operationNumber: TemplateParam = { name: "operationNumber", example: "4471" };

function template(name: WhatsAppTemplateName, kind: MessageKind, body: string, params: readonly TemplateParam[], buttons: readonly TemplateButton[] = []): TemplateDefinition {
  return { name, kind, category: WHATSAPP_TEMPLATE_CATEGORY, language: WHATSAPP_TEMPLATE_LANGUAGE, body, params, buttons };
}

export const TEMPLATES: Readonly<Record<WhatsAppTemplateName, TemplateDefinition>> = {
  legajo_docs_pendientes: template(
    "legajo_docs_pendientes",
    "DOCS_REQUEST",
    "Hola, te escribimos del estudio {{1}}. Operación {{2}}, buque {{3}}, arribo estimado {{4}}. Faltan: {{5}}. ¿Cómo seguimos?",
    [
      { name: "firmName", example: "Estudio Delta" },
      operationNumber,
      { name: "vessel", example: "Austral Aurora" },
      { name: "etaText", example: "22/10" },
      { name: "missingDocuments", example: "certificado de origen y packing list" },
    ],
    [uploadButton, supplierSendsButton, questionButton, optOutButton],
  ),
  legajo_recordatorio: template(
    "legajo_recordatorio",
    "REMINDER",
    "Operación {{1}}: siguen faltando {{2}}. El plazo es el {{3}}. Podés subirlos o avisarnos.",
    [operationNumber, { name: "missingDocuments", example: "certificado de origen y packing list" }, { name: "deadlineText", example: "19/10 10:00" }],
    [uploadButton, supplierSendsButton, questionButton],
  ),
  legajo_observacion_proveedor: template(
    "legajo_observacion_proveedor",
    "NO_ACTION_NEEDED",
    "Operación {{1}}: el proveedor tiene que corregir {{2}}. Ya se lo pedimos; no tenés que hacer nada por ahora.",
    [operationNumber, { name: "correctionTarget", example: "el peso bruto del packing list" }],
    [questionButton],
  ),
  legajo_contacto_proveedor: template(
    "legajo_contacto_proveedor",
    "CONTACT_REQUEST",
    "Operación {{1}}: no pudimos entregar el correo a tu proveedor ({{2}}). ¿Nos pasás otro contacto?",
    [operationNumber, { name: "supplierName", example: "Konkan Chemicals Pvt Ltd" }],
    [otherContactButton, talkToFirmButton],
  ),
  legajo_nuevo_plazo: template(
    "legajo_nuevo_plazo",
    "ETA_CHANGE",
    "Operación {{1}}: el arribo estimado cambió al {{2}}. El nuevo plazo para la documentación es el {{3}}.",
    [operationNumber, { name: "etaText", example: "20/10" }, { name: "deadlineText", example: "17/10 10:00" }],
    [questionButton],
  ),
  legajo_escalado: template(
    "legajo_escalado",
    "ESCALATION_NOTICE",
    "Operación {{1}}: una persona del estudio {{2}} va a seguir con vos por este chat.",
    [operationNumber, { name: "firmName", example: "Estudio Delta" }],
  ),
  legajo_aprobado: template(
    "legajo_aprobado",
    "APPROVAL_NOTICE",
    "Operación {{1}}: el estudio aprobó el legajo. Te vamos a avisar las novedades del despacho por acá.",
    [operationNumber],
  ),
  despacho_estado: template(
    "despacho_estado",
    "DISPATCH_STATUS",
    "Operación {{1}}: {{2}}. {{3}} Ante cualquier duda, consultá con el estudio.",
    [
      operationNumber,
      { name: "dispatchStatusText", example: "la aduana asignó canal naranja" },
      { name: "genericExplanation", example: "Significa que la aduana va a revisar la documentación antes de liberar la mercadería." },
    ],
    [talkToFirmButton],
  ),
};

/** Template of each message kind that has one; the rest are free text inside the 24 h window. */
export const TEMPLATE_FOR_KIND: Readonly<Partial<Record<MessageKind, WhatsAppTemplateName>>> = Object.fromEntries(
  WhatsAppTemplateName.options.map((name) => [TEMPLATES[name].kind, name]),
);

/** Meta rejects a parameter with a line break, a tab or more than four spaces in a row. */
export function isValidTemplateParam(value: string): boolean {
  return value.trim() !== "" && !/[\n\r\t]| {5,}/.test(value);
}

export interface RenderedTemplateButton {
  readonly type: TemplateButton["type"];
  readonly action: TemplateButton["action"];
  readonly text: string;
  readonly url?: string;
}

export interface RenderedTemplate {
  readonly name: WhatsAppTemplateName;
  readonly body: string;
  readonly buttons: readonly RenderedTemplateButton[];
}

/**
 * The template as the importer sees it. `uploadToken` fills the URL button, and is required exactly
 * when the template has one. Throws on a wrong arity or an invalid parameter: never sends half a template.
 */
export function renderTemplate(name: WhatsAppTemplateName, params: readonly string[], uploadToken?: string): RenderedTemplate {
  const definition = TEMPLATES[name];
  const invalid = params.findIndex((value) => !isValidTemplateParam(value));
  if (invalid !== -1) throw new RangeError(`parameter ${invalid + 1} of ${name} is empty or has a line break`);
  const hasUrl = definition.buttons.some((button) => button.type === "URL");
  if (hasUrl !== (uploadToken !== undefined)) throw new RangeError(`${name} ${hasUrl ? "needs" : "takes no"} upload token`);
  return {
    name,
    body: fillPlaceholders(definition.body, params),
    buttons: definition.buttons.map((button) =>
      button.type === "URL" ? { type: button.type, action: button.action, text: button.text, url: uploadLinkUrl(uploadToken ?? "") } : button,
    ),
  };
}
