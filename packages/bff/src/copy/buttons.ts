// WhatsApp button titles. The model never writes one: `send_whatsapp` takes an action, the code turns
// it into a nonce and puts the title from here (docs/tool-catalog.md, `send_whatsapp`). Each action
// has both lengths WhatsApp allows, so an adapter never truncates a title at send time.
import type { WaButtonAction } from "@legajo/shared";
import { charCount } from "./helpers";
import type { ButtonLabel } from "./types";

/** Quick reply and URL buttons of a template (Meta). */
export const TEMPLATE_BUTTON_MAX_CHARS = 25;
/** Reply buttons of an interactive message, and the button that opens a list. */
export const INTERACTIVE_BUTTON_MAX_CHARS = 20;
/** Row title of an interactive list. */
export const LIST_ROW_TITLE_MAX_CHARS = 24;
/** Row description of an interactive list. */
export const LIST_ROW_DESCRIPTION_MAX_CHARS = 72;
/** Reply buttons per interactive message. */
export const INTERACTIVE_MAX_BUTTONS = 3;
/** Rows of an interactive list. */
export const LIST_MAX_ROWS = 10;

const same = (text: string): ButtonLabel => ({ template: text, interactive: text });

export const BUTTON_LABELS: Readonly<Record<WaButtonAction, ButtonLabel>> = {
  UPLOAD: same("Subir documentos"),
  SUPPLIER_SENDS: { template: "Los manda el proveedor", interactive: "Proveedor los manda" },
  QUESTION: same("Tengo una duda"),
  OPT_OUT: same("No recibir avisos"),
  CONFIRM_CONTACT: same("Sí, escribile"),
  REJECT_CONTACT: same("No"),
  OTHER_CONTACT: { template: "Te paso otro contacto", interactive: "Otro contacto" },
  TALK_TO_FIRM: { template: "Hablar con el estudio", interactive: "Consultar al estudio" },
  // The button that opens the `OPERATION_CHOICE` list; each row is `operationRowTitle`.
  CHOOSE_OPERATION: same("Elegir operación"),
};

/** Row title of the `OPERATION_CHOICE` list: "Operación 4471". */
export function operationRowTitle(operationNumber: string): string {
  return `Operación ${operationNumber}`;
}

export function fitsButtonLimits(label: ButtonLabel): boolean {
  return charCount(label.template) <= TEMPLATE_BUTTON_MAX_CHARS && charCount(label.interactive) <= INTERACTIVE_BUTTON_MAX_CHARS;
}
