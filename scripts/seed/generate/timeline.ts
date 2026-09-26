// Builders of the seeded history of an operation: WhatsApp and email messages as the outbound pipeline
// and the channel entries would have stored them, and the `AuditLog` decisions behind each one
// (docs/architecture.md §5 and §12). Every outbound message carries its `ALLOW` with the rules
// evaluated (PolicyAudit check a); every deferral its `DEFER` and a fired `TIMER#DEFERRED_SEND`. Ids
// are ULIDs drawn from the seed's PRNG with the simulated instant as their time part.
import { CONTACT_POLICY_RULES, type ContactPolicyRuleId, type DocType, type MessageKind, type WaButtonAction, type WhatsAppTemplateName } from "@legajo/shared";
import { BUTTON_LABELS } from "@legajo/bff/copy/buttons";
import { renderTemplate } from "@legajo/bff/copy/templates";
import { newPublicToken, ulid } from "@legajo/bff/lib/crypto";
import { SEED_REAL_NOW } from "../lib/constants";
import { THREAD_ADDRESS_PLACEHOLDER, templateItem, type SeedItem } from "../lib/items";
import type { Rng } from "./rng";
import { utc } from "./time";
import type { WorldContext, WorldOperation } from "./world-context";

export interface StoryScope {
  readonly world: WorldContext;
  readonly op: WorldOperation;
  readonly rng: Rng;
}

const at = (instant: string): number => Date.parse(instant);

export function messageIdAt(scope: StoryScope, instant: string): string {
  return `msg-${ulid(at(instant), (size) => scope.rng.bytes(size))}`;
}

function decisionIdAt(scope: StoryScope, instant: string): string {
  return ulid(at(instant), (size) => scope.rng.bytes(size));
}

export function uploadToken(scope: StoryScope): string {
  return newPublicToken((size) => scope.rng.bytes(size));
}

/** SES message id and the `Message-ID` it becomes (`<id@email.amazonses.com>`). */
function sesIds(scope: StoryScope): { providerMessageId: string; rfcMessageId: string } {
  const hex = (bytes: number) => Array.from(scope.rng.bytes(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const providerMessageId = `0100${hex(6)}-${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}-000000`;
  return { providerMessageId, rfcMessageId: `<${providerMessageId}@email.amazonses.com>` };
}

// ---- Rules evaluated (the ALLOW, DEFER and DENY rows of AuditLog) -------------------------------

type Route = "WHATSAPP" | "EMAIL";

export interface SendFlags {
  readonly route: Route;
  readonly kind: MessageKind;
  readonly author: string;
  /** Answers a WhatsApp message of the importer inside its window (exempt from CP-HOURS-AR). */
  readonly reply: boolean;
  readonly template: boolean;
}

function outcomeOf(rule: ContactPolicyRuleId, flags: SendFlags): { result: "PASS" | "SKIP"; detail: string } {
  const whatsapp = flags.route === "WHATSAPP";
  const onlyIf = (applies: boolean, pass: string, skip: string) => (applies ? { result: "PASS" as const, detail: pass } : { result: "SKIP" as const, detail: skip });
  switch (rule) {
    case "CP-CONTROL-BROKER":
      return onlyIf(flags.author === "AGENT", "the agent has the conversation", "not written by the agent");
    case "CP-KIND-CHANNEL":
      return { result: "PASS", detail: `${flags.kind} goes to the ${whatsapp ? "importer by WhatsApp" : "supplier by email"}` };
    case "CP-RECIPIENT-FENCE":
      return { result: "PASS", detail: whatsapp ? "the importer's registered phone" : "a registered contact inside the SYSTEM fence" };
    case "CP-OPTIN":
    case "CP-OPTOUT":
    case "CP-WA-24H":
      return onlyIf(whatsapp, flags.template ? "opt-in in force; approved template" : "opt-in in force; inside the 24-hour window", "only WhatsApp to the importer");
    case "CP-SUPPLIER-AUTH":
    case "CP-BOUNCED-CONTACT":
    case "CP-HOURS-SUPPLIER":
      return onlyIf(!whatsapp, "authorized, confirmed and active contact, inside the supplier's hours", "only email to the supplier");
    case "CP-APPROVED-SCOPE":
      return { result: "PASS", detail: "allowed for the dossier's status" };
    case "CP-HOURS-AR":
      return onlyIf(whatsapp && !flags.reply, "inside Buenos Aires business hours", flags.reply ? "a reply to the importer is exempt" : "only WhatsApp to the importer");
    case "CP-ONE-PER-DAY":
      return onlyIf(flags.kind === "DOCS_REQUEST" || flags.kind === "REMINDER", "first request or reminder of the day for this contact", "only DOCS_REQUEST and REMINDER count");
    case "CP-NO-SENSITIVE-ASK":
      return { result: "PASS", detail: "asks for no identity, bank or card data" };
    case "CP-NO-FOREIGN-LINKS":
      return { result: "PASS", detail: flags.template ? "no free text: approved template" : "no link or contact outside the turn's" };
  }
}

export interface Evaluation {
  readonly ruleIds: ContactPolicyRuleId[];
  readonly evaluated: { ruleId: ContactPolicyRuleId; result: "PASS" | "SKIP" | "DEFER" | "DENY"; detail: string }[];
}

/** An allowed send: every rule in the engine's order, `ruleIds` = the ones that passed. */
export function allowed(flags: SendFlags): Evaluation {
  const evaluated = CONTACT_POLICY_RULES.map((ruleId) => ({ ruleId, ...outcomeOf(ruleId, flags) }));
  return { ruleIds: evaluated.filter((entry) => entry.result === "PASS").map((entry) => entry.ruleId), evaluated };
}

/** A send stopped by `stopper` (the first rule that denies or defers cuts the evaluation). */
export function stopped(flags: SendFlags, stopper: ContactPolicyRuleId, result: "DEFER" | "DENY", detail: string): Evaluation {
  const index = CONTACT_POLICY_RULES.indexOf(stopper);
  const before = CONTACT_POLICY_RULES.slice(0, index).map((ruleId) => ({ ruleId, ...outcomeOf(ruleId, flags) }));
  return { ruleIds: [stopper], evaluated: [...before, { ruleId: stopper, result, detail }] };
}

// ---- Decisions -----------------------------------------------------------------------------------

export interface DecisionInput {
  readonly atSim: string;
  readonly decision: "ALLOW" | "DENY" | "DEFER" | "ACTION";
  readonly action: string;
  readonly actor: string;
  readonly evaluation?: Evaluation;
  readonly messageId?: string;
  readonly trigger?: string;
  readonly refs?: Readonly<Record<string, string>>;
  readonly reason?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export function decision(scope: StoryScope, input: DecisionInput): SeedItem {
  const ts = utc(input.atSim);
  const { world, op } = scope;
  return templateItem("Decision", {
    decisionId: decisionIdAt(scope, input.atSim),
    firmId: world.firm.firmId,
    month: ts.slice(0, 7),
    ts,
    decision: input.decision,
    action: input.action,
    ruleIds: input.evaluation?.ruleIds ?? (input.action === "RESPONSIBLE_ASSIGNED" ? ["RESP-MATRIX"] : []),
    evaluated: input.evaluation?.evaluated ?? [],
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    actor: input.actor,
    refs: { operationId: op.operationId, ...(input.messageId === undefined ? {} : { messageId: input.messageId }), ...input.refs },
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    clockId: world.clockId,
    operationId: op.operationId,
    atSim: input.atSim,
    atReal: SEED_REAL_NOW,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });
}

// ---- Messages ------------------------------------------------------------------------------------

interface MessageCommon {
  readonly messageId: string;
  readonly atSim: string;
  readonly kind?: MessageKind;
  readonly author: string;
  readonly evaluation?: Evaluation;
  readonly nextAllowedAt?: string;
  readonly deferredTimerKey?: string;
  readonly docTypes?: readonly DocType[];
}

function base(scope: StoryScope, common: MessageCommon, fields: Record<string, unknown>): SeedItem {
  const { world, op } = scope;
  return templateItem("Message", {
    messageId: common.messageId,
    operationId: op.operationId,
    firmId: world.firm.firmId,
    clockId: world.clockId,
    ...(common.kind === undefined ? {} : { kind: common.kind }),
    author: common.author,
    sentAtSim: utc(common.atSim),
    sentAtReal: SEED_REAL_NOW,
    ...(common.evaluation === undefined ? {} : { policy: { decision: "ALLOW", ruleIds: common.evaluation.ruleIds, ...(common.nextAllowedAt === undefined ? {} : { nextAllowedAt: common.nextAllowedAt }) } }),
    ...(common.deferredTimerKey === undefined ? {} : { deferredTimerKey: common.deferredTimerKey }),
    refs: common.docTypes === undefined ? {} : { docTypes: [...common.docTypes] },
    ...fields,
  });
}

/** A WhatsApp template to the importer, rendered by the copy the live adapter uses. */
export function whatsAppTemplateOut(scope: StoryScope, common: MessageCommon, name: WhatsAppTemplateName, params: readonly string[], token?: string): SeedItem {
  const rendered = renderTemplate(name, params, token);
  return base(scope, common, {
    direction: "OUT",
    channel: "WHATSAPP",
    counterpart: "IMPORTER",
    importerId: scope.op.importer.importerId,
    to: scope.op.importer.phoneE164,
    from: "simulated",
    body: rendered.body,
    template: { name, params: [...params] },
    buttons: rendered.buttons.map((button) => ({ action: button.action, title: button.text, ...(button.url === undefined ? {} : { url: button.url }) })),
    status: "READ",
    simulated: true,
  });
}

/** Free text to the importer inside the window, with reply buttons when it asks to choose. */
export function whatsAppTextOut(scope: StoryScope, common: MessageCommon, body: string, buttons: readonly WaButtonAction[] = []): SeedItem {
  return base(scope, common, {
    direction: "OUT",
    channel: "WHATSAPP",
    counterpart: "IMPORTER",
    importerId: scope.op.importer.importerId,
    to: scope.op.importer.phoneE164,
    from: "simulated",
    body,
    buttons: buttons.map((action) => ({ action, title: BUTTON_LABELS[action].interactive })),
    ...(buttons.length > 0 ? { interactive: { type: "button", actions: [...buttons] } } : {}),
    status: "READ",
    simulated: true,
  });
}

export interface InboundAttachment {
  readonly docVersionId: string;
  readonly sizeBytes: number;
}

/** A WhatsApp message of the importer: a text, a button reply or a PDF (from the phone simulator). */
export function whatsAppIn(scope: StoryScope, common: MessageCommon, body: string, extra: { button?: WaButtonAction; attachment?: InboundAttachment } = {}): SeedItem {
  const { attachment, button } = extra;
  return base(scope, common, {
    direction: "IN",
    channel: "WHATSAPP",
    counterpart: "IMPORTER",
    importerId: scope.op.importer.importerId,
    to: "simulated",
    from: scope.op.importer.phoneE164,
    body,
    ...(button === undefined ? {} : { interactive: { type: "button_reply", action: button } }),
    attachments: attachment === undefined ? [] : [{ index: 0, contentType: "application/pdf", sizeBytes: attachment.sizeBytes, status: "ACCEPTED", docVersionId: attachment.docVersionId, s3Key: `sim/${common.messageId}/0.pdf` }],
    status: "RECEIVED",
    trusted: true,
    simulated: true,
  });
}

/** An email to the supplier from the operation's thread address, chained to the previous one. */
export function emailOut(scope: StoryScope, common: MessageCommon, subject: string, body: string, previous?: SeedItem): SeedItem {
  const ids = sesIds(scope);
  const parent = typeof previous?.rfcMessageId === "string" ? previous.rfcMessageId : undefined;
  return base(scope, common, {
    direction: "OUT",
    channel: "EMAIL",
    counterpart: "SUPPLIER",
    contactId: scope.op.supplier.contactId,
    to: scope.op.supplier.contactEmail,
    from: THREAD_ADDRESS_PLACEHOLDER,
    subject,
    body,
    ...ids,
    ...(parent === undefined ? {} : { inReplyTo: parent, references: [parent] }),
    status: "DELIVERED",
    simulated: false,
  });
}
