// The Meta Cloud API message every WhatsApp send carries (docs/architecture-integrations.md §4.1): the
// JSON `SendWhatsAppMessage` takes as bytes in live mode and the simulated transport validates with the
// same schema. Three shapes: text (`preview_url: false`), interactive (reply buttons or a list) and an
// approved template in `es_AR` whose quick replies carry a nonce as payload and whose URL button
// carries the upload token as suffix. The builders enforce Meta's limits, so an invalid message fails
// here and never reaches a transport.
import { z } from "zod";
import { WhatsAppTemplateName } from "@legajo/shared";
import {
  INTERACTIVE_BUTTON_MAX_CHARS,
  INTERACTIVE_MAX_BUTTONS,
  LIST_MAX_ROWS,
  LIST_ROW_DESCRIPTION_MAX_CHARS,
  LIST_ROW_TITLE_MAX_CHARS,
} from "../../copy/buttons";
import { charCount } from "../../copy/helpers";
import { TEMPLATES, isValidTemplateParam } from "../../copy/templates";
import { PUBLIC_TOKEN_PATTERN } from "../../lib/crypto";
import { MESSAGING_PRODUCT, TEMPLATE_LANGUAGE_CODE } from "./config";
import type { SystemReplyRequest } from "./ports";

/** Body of a text message and of an interactive one (Meta). */
export const TEXT_BODY_MAX_CHARS = 4_096;
export const INTERACTIVE_BODY_MAX_CHARS = 1_024;
const chars = (max: number) => z.string().min(1).refine((value) => charCount(value) <= max, `at most ${max} characters`);
/** `to`: the recipient's number as Meta writes a `wa_id` (digits, no `+`). */
const To = z.string().regex(/^\d{8,15}$/, "expected the recipient's number without '+'");
/** Ids of reply buttons and list rows, and quick-reply payloads: our nonces (`Runtime/NONCE#`). */
const ReplyId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "expected a nonce");
const envelopeFields = { messaging_product: z.literal(MESSAGING_PRODUCT), recipient_type: z.literal("individual"), to: To };

const TextMessage = z.strictObject({
  ...envelopeFields,
  type: z.literal("text"),
  text: z.strictObject({ preview_url: z.literal(false), body: chars(TEXT_BODY_MAX_CHARS) }),
});

const ButtonsInteractive = z.strictObject({
  type: z.literal("button"),
  body: z.strictObject({ text: chars(INTERACTIVE_BODY_MAX_CHARS) }),
  action: z.strictObject({
    buttons: z
      .array(z.strictObject({ type: z.literal("reply"), reply: z.strictObject({ id: ReplyId, title: chars(INTERACTIVE_BUTTON_MAX_CHARS) }) }))
      .min(1)
      .max(INTERACTIVE_MAX_BUTTONS),
  }),
});

const ListInteractive = z.strictObject({
  type: z.literal("list"),
  body: z.strictObject({ text: chars(INTERACTIVE_BODY_MAX_CHARS) }),
  action: z.strictObject({
    button: chars(INTERACTIVE_BUTTON_MAX_CHARS),
    sections: z
      .array(
        z.strictObject({
          rows: z
            .array(z.strictObject({ id: ReplyId, title: chars(LIST_ROW_TITLE_MAX_CHARS), description: chars(LIST_ROW_DESCRIPTION_MAX_CHARS).optional() }))
            .min(1)
            .max(LIST_MAX_ROWS),
        }),
      )
      .length(1),
  }),
});

const InteractiveMessage = z.strictObject({
  ...envelopeFields,
  type: z.literal("interactive"),
  interactive: z.discriminatedUnion("type", [ButtonsInteractive, ListInteractive]),
});

const TextParameter = z.strictObject({ type: z.literal("text"), text: z.string().min(1).refine(isValidTemplateParam, "invalid template parameter") });
const BodyComponent = z.strictObject({ type: z.literal("body"), parameters: z.array(TextParameter) });
const QuickReplyComponent = z.strictObject({
  type: z.literal("button"),
  sub_type: z.literal("quick_reply"),
  index: z.string().regex(/^\d$/),
  parameters: z.tuple([z.strictObject({ type: z.literal("payload"), payload: ReplyId })]),
});
const UrlComponent = z.strictObject({
  type: z.literal("button"),
  sub_type: z.literal("url"),
  index: z.string().regex(/^\d$/),
  parameters: z.tuple([z.strictObject({ type: z.literal("text"), text: z.string().regex(PUBLIC_TOKEN_PATTERN, "expected an upload token") })]),
});

const TemplateMessage = z.strictObject({
  ...envelopeFields,
  type: z.literal("template"),
  template: z.strictObject({
    name: WhatsAppTemplateName,
    language: z.strictObject({ code: z.literal(TEMPLATE_LANGUAGE_CODE) }),
    components: z.array(z.union([BodyComponent, QuickReplyComponent, UrlComponent])),
  }),
});

/** Every message a transport accepts; the simulated one validates with this same schema (§4.2). */
export const MetaMessage = z.discriminatedUnion("type", [TextMessage, InteractiveMessage, TemplateMessage]).superRefine((message, ctx) => {
  if (message.type === "template") {
    const problem = templateProblem(message.template.name, message.template.components);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem, path: ["template"] });
  }
});
export type MetaMessage = z.infer<typeof MetaMessage>;
type TemplateComponent = z.infer<typeof TemplateMessage>["template"]["components"][number];

/** The template's parameters and buttons have to match its definition in copy/templates.ts exactly. */
function templateProblem(name: WhatsAppTemplateName, components: readonly TemplateComponent[]): string | undefined {
  const definition = TEMPLATES[name];
  const bodies = components.filter((component) => component.type === "body");
  const params = bodies[0]?.parameters.length ?? 0;
  if (bodies.length > 1) return `${name} has more than one body component`;
  if (params !== definition.params.length) return `${name} takes ${definition.params.length} parameters, got ${params}`;
  const buttons = components.filter((component) => component.type === "button");
  if (buttons.length !== definition.buttons.length) return `${name} has ${definition.buttons.length} buttons, got ${buttons.length}`;
  for (const [index, button] of definition.buttons.entries()) {
    const component = buttons.find((candidate) => candidate.index === String(index));
    const expected = button.type === "URL" ? "url" : "quick_reply";
    if (component?.sub_type !== expected) return `${name} button ${index} must be ${expected}`;
  }
  return undefined;
}

// ---- Builders ---------------------------------------------------------------------------------------

export interface ReplyButton {
  /** The nonce the importer's tap sends back. */
  readonly id: string;
  readonly title: string;
}

export interface ListRow extends ReplyButton {
  readonly description?: string;
}

/** A button of a template, in the order of its definition: a nonce for a quick reply, the token for the URL. */
export type TemplateButtonValue = { readonly nonce: string } | { readonly uploadToken: string };

export type WaOutbound =
  | { readonly kind: "text"; readonly to: string; readonly body: string }
  | { readonly kind: "buttons"; readonly to: string; readonly body: string; readonly buttons: readonly ReplyButton[] }
  | { readonly kind: "list"; readonly to: string; readonly body: string; readonly buttonTitle: string; readonly rows: readonly ListRow[] }
  | { readonly kind: "template"; readonly to: string; readonly name: WhatsAppTemplateName; readonly params: readonly string[]; readonly buttons: readonly TemplateButtonValue[] };

/** `+5491155500101` → `5491155500101`, the form Meta uses in `to`. */
export function recipientOf(phoneE164: string): string {
  return phoneE164.replace(/^\+/, "");
}

function templateComponents(name: WhatsAppTemplateName, params: readonly string[], values: readonly TemplateButtonValue[]): TemplateComponent[] {
  const definition = TEMPLATES[name];
  if (values.length !== definition.buttons.length) throw new RangeError(`${name} has ${definition.buttons.length} buttons, got ${values.length} values`);
  const components: TemplateComponent[] = params.length === 0 ? [] : [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }];
  definition.buttons.forEach((button, position) => {
    const value = values[position];
    const index = String(position);
    if (button.type === "URL") {
      if (value === undefined || !("uploadToken" in value)) throw new RangeError(`${name} button ${index} needs the upload token`);
      components.push({ type: "button", sub_type: "url", index, parameters: [{ type: "text", text: value.uploadToken }] });
    } else {
      if (value === undefined || !("nonce" in value)) throw new RangeError(`${name} button ${index} needs a nonce`);
      components.push({ type: "button", sub_type: "quick_reply", index, parameters: [{ type: "payload", payload: value.nonce }] });
    }
  });
  return components;
}

function unvalidated(outbound: WaOutbound): unknown {
  const envelope = { messaging_product: MESSAGING_PRODUCT, recipient_type: "individual", to: recipientOf(outbound.to) };
  switch (outbound.kind) {
    case "text":
      return { ...envelope, type: "text", text: { preview_url: false, body: outbound.body } };
    case "buttons":
      return { ...envelope, type: "interactive", interactive: { type: "button", body: { text: outbound.body }, action: { buttons: outbound.buttons.map((button) => ({ type: "reply", reply: { id: button.id, title: button.title } })) } } };
    case "list":
      return {
        ...envelope,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: outbound.body },
          action: { button: outbound.buttonTitle, sections: [{ rows: outbound.rows.map((row) => ({ id: row.id, title: row.title, ...(row.description === undefined ? {} : { description: row.description }) })) }] },
        },
      };
    case "template":
      return { ...envelope, type: "template", template: { name: outbound.name, language: { code: TEMPLATE_LANGUAGE_CODE }, components: templateComponents(outbound.name, outbound.params, outbound.buttons) } };
  }
}

/** The Meta JSON of `outbound`, validated; throws a ZodError (or RangeError) instead of building an invalid one. */
export function toMetaMessage(outbound: WaOutbound): MetaMessage {
  return MetaMessage.parse(unvalidated(outbound));
}

/** The bytes `SendWhatsAppMessage.message` takes. */
export function metaMessageBytes(message: MetaMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

/**
 * What `SendWhatsAppMessage` takes: the Meta JSON with the recipient in E.164 (`+` first). End User
 * Messaging Social refuses Meta's bare digits ("Invalid destination phone number"), so the `+` is added
 * here, at the AWS boundary; the message itself keeps Meta's format (simulator, fixtures, nonces).
 */
export function eumMessageBytes(message: MetaMessage): Uint8Array {
  return metaMessageBytes({ ...message, to: `+${message.to}` } as MetaMessage);
}

/** The nonces a message carries (quick-reply payloads, reply-button and list-row ids). */
export function noncesOf(message: MetaMessage): string[] {
  if (message.type === "text") return [];
  if (message.type === "template") return message.template.components.flatMap((component) => (component.type === "button" && component.sub_type === "quick_reply" ? [component.parameters[0].payload] : []));
  const interactive = message.interactive;
  return interactive.type === "button" ? interactive.action.buttons.map((button) => button.reply.id) : interactive.action.sections.flatMap((section) => section.rows.map((row) => row.id));
}

/** The Meta message of a fixed reply of the inbound adapter (ports.ts `SystemReplyRequest`) to the importer's phone. */
export function systemReplyMessage(request: Pick<SystemReplyRequest, "body" | "list">, toPhoneE164: string): MetaMessage {
  if (request.list === undefined) return toMetaMessage({ kind: "text", to: toPhoneE164, body: request.body });
  const rows = request.list.rows.map((row) => ({ id: row.nonce, title: row.title, description: row.description }));
  return toMetaMessage({ kind: "list", to: toPhoneE164, body: request.body, buttonTitle: request.list.buttonTitle, rows });
}
