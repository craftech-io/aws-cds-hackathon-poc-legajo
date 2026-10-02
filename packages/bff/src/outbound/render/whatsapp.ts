// The WhatsApp a send becomes (docs/tool-catalog.md `send_whatsapp`, docs/architecture-integrations.md
// §4): the Meta message both transports take (channels/whatsapp/meta-message.ts `toMetaMessage`, which
// enforces Meta's limits), what the importer reads (`body`) and the buttons the `Message OUT` records.
//
//   template      an approved `es_AR` template (copy/templates.ts) with the parameters in order; its
//                 quick replies carry a nonce each and its URL button the upload token
//   text          free text (only inside the 24-hour window, decided by the policy); with buttons it is
//                 an interactive message of reply buttons
//
// Every button title comes from copy/buttons.ts and every button becomes a nonce bound to the importer's
// phone hash and the operation (`Runtime/NONCE#`, channels/whatsapp/nonces.ts): the model only names
// actions. Nonces derive from the message id, so rendering the same message again issues the same ones.
import { ToolError, type WaButtonAction, type WhatsAppTemplateName } from "@legajo/shared";
import { BUTTON_LABELS, INTERACTIVE_MAX_BUTTONS } from "../../copy/buttons";
import { TEMPLATES, renderTemplate } from "../../copy/templates";
import type { Connector } from "../../connector/connector";
import { type ButtonToIssue, issueNonces } from "../../channels/whatsapp/nonces";
import { type MetaMessage, type TemplateButtonValue, toMetaMessage } from "../../channels/whatsapp/meta-message";
import type { MessageButton } from "../../domain/conversations";
import type { SecretKey } from "../../lib/crypto";
import type { OutboundButton } from "../types";

export interface WhatsAppRenderInput {
  readonly messageId: string;
  /** The importer's registered phone (E.164). */
  readonly to: string;
  readonly text?: string;
  readonly template?: { readonly name: WhatsAppTemplateName; readonly params: readonly string[] };
  readonly buttons?: readonly OutboundButton[];
  /** The upload link token of a template with a URL button. */
  readonly uploadToken?: string;
  readonly nonceKey: SecretKey;
  readonly operationId: string;
  readonly importerId: string;
  readonly phoneHash: string;
  readonly clockId: string;
  /** Real time: a nonce lives seven real days. */
  readonly now: Date;
}

export interface RenderedWhatsApp {
  readonly message: MetaMessage;
  /** What the importer reads: the template's body filled, or the text. */
  readonly body: string;
  readonly buttons: readonly MessageButton[];
  readonly template?: { readonly name: WhatsAppTemplateName; readonly params: readonly string[] };
}

/** The template's buttons, in order: what an input naming buttons next to a template must match. */
export function templateActions(name: WhatsAppTemplateName): WaButtonAction[] {
  return TEMPLATES[name].buttons.map((button) => button.action);
}

/** True when the template has a URL button, which needs an upload link. */
export function needsUploadLink(name: WhatsAppTemplateName): boolean {
  return TEMPLATES[name].buttons.some((button) => button.type === "URL");
}

function invalid(message: string): ToolError {
  return new ToolError("INVALID", message, "CONTENT_INVALID");
}

/** Checks what the caller asked for before anything is issued: shape only, the policy decides the rest. */
export function checkWhatsAppShape(input: Pick<WhatsAppRenderInput, "text" | "template" | "buttons">, kind: string): void {
  const { text, template, buttons = [] } = input;
  if ((text === undefined) === (template === undefined)) throw invalid("send either a text or a template");
  if (template !== undefined) {
    const definition = TEMPLATES[template.name];
    if (definition.kind !== kind) throw invalid(`template ${template.name} carries ${definition.kind}, not ${kind}`);
    if (template.params.length !== definition.params.length) throw invalid(`template ${template.name} takes ${definition.params.length} parameters, got ${template.params.length}`);
    const expected = templateActions(template.name);
    if (buttons.length > 0 && (buttons.length !== expected.length || buttons.some((button, index) => button.action !== expected[index]))) {
      throw invalid(`the buttons of ${template.name} are fixed: ${expected.join(", ") || "none"}`);
    }
    return;
  }
  if (buttons.length > INTERACTIVE_MAX_BUTTONS) throw invalid(`at most ${INTERACTIVE_MAX_BUTTONS} buttons`);
  if (new Set(buttons.map((button) => button.action)).size !== buttons.length) throw invalid("a button action appears twice");
}

async function nonces(runtime: Connector["runtime"], input: WhatsAppRenderInput, buttons: readonly ButtonToIssue[]): Promise<string[]> {
  if (buttons.length === 0) return [];
  return issueNonces(runtime, {
    nonceKey: input.nonceKey,
    messageId: input.messageId,
    operationId: input.operationId,
    importerId: input.importerId,
    phoneHash: input.phoneHash,
    clockId: input.clockId,
    buttons,
    now: input.now,
  });
}

async function renderTemplateMessage(runtime: Connector["runtime"], input: WhatsAppRenderInput, template: NonNullable<WhatsAppRenderInput["template"]>): Promise<RenderedWhatsApp> {
  let rendered;
  try {
    rendered = renderTemplate(template.name, template.params, needsUploadLink(template.name) ? input.uploadToken : undefined);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "invalid template parameters");
  }
  const quickReplies = rendered.buttons.filter((button) => button.type === "QUICK_REPLY").map((button) => ({ action: button.action }));
  const issued = await nonces(runtime, input, quickReplies);
  let next = 0;
  const values: TemplateButtonValue[] = [];
  const recorded: MessageButton[] = [];
  for (const button of rendered.buttons) {
    if (button.type === "URL") {
      values.push({ uploadToken: input.uploadToken ?? "" });
      recorded.push({ action: button.action, title: button.text, ...(button.url === undefined ? {} : { url: button.url }) });
      continue;
    }
    const nonce = issued[next] ?? "";
    next += 1;
    values.push({ nonce });
    recorded.push({ action: button.action, title: button.text, nonce });
  }
  const message = toMetaMessage({ kind: "template", to: input.to, name: template.name, params: template.params, buttons: values });
  return { message, body: rendered.body, buttons: recorded, template: { name: template.name, params: [...template.params] } };
}

/** Renders the send; throws `INVALID` for a shape the transports would refuse. */
export async function renderWhatsApp(runtime: Connector["runtime"], input: WhatsAppRenderInput): Promise<RenderedWhatsApp> {
  if (input.template !== undefined) return renderTemplateMessage(runtime, input, input.template);
  const body = input.text ?? "";
  const buttons = input.buttons ?? [];
  const issued = await nonces(runtime, input, buttons.map((button) => ({ action: button.action, ...(button.payload === undefined ? {} : { payload: button.payload }) })));
  const recorded: MessageButton[] = buttons.map((button, index) => ({ action: button.action, title: BUTTON_LABELS[button.action].interactive, nonce: issued[index] ?? "" }));
  try {
    const message =
      buttons.length === 0
        ? toMetaMessage({ kind: "text", to: input.to, body })
        : toMetaMessage({ kind: "buttons", to: input.to, body, buttons: recorded.map((button) => ({ id: button.nonce ?? "", title: button.title })) });
    return { message, body, buttons: recorded };
  } catch (error) {
    throw invalid(error instanceof Error ? "the message does not fit WhatsApp's limits" : "invalid message");
  }
}
