// The rules that do not depend on the hour (docs/design-brief.md §5.7): who has the conversation,
// the kind → channel matrix, the recipient fence, the opt-in and opt-out, the supplier authorization
// and contact status, the scope of an approved dossier, the two content rules and the quota of a
// guest world's emails (`CP-WORLD-QUOTA`, policy/world-quota.ts, ADR-0015 §4). Every dated fact
// is read from its history at the decided instant; a send decided now also honours the current value
// when it is the stricter one, so a history that lags the item can never let a send through.
import { normalizePhone } from "@legajo/shared";
import { findSensitiveAsk } from "../copy/forbidden";
import { entryAt } from "../domain/common";
import { controlAt, dossierStatusAt } from "../domain/operations";
import { authorizationActiveAt, contactStatusAt } from "../domain/parties";
import { deny, missing, pass, recipientText, skip } from "./checks";
import type { PolicyContext } from "./context";
import { APPROVED_IMPORTER_KINDS, KIND_ROUTES, OPT_OUT_CONFIRMATION, TO_IMPORTER } from "./kinds";
import type { RuleCheck } from "./types";

function atSim(ctx: PolicyContext): string {
  return ctx.simNow.toISOString();
}

function sending(ctx: PolicyContext): boolean {
  return ctx.mode === "SEND";
}

/** `CP-CONTROL-BROKER`: while the firm has the conversation the agent does not send. */
export function checkControl(ctx: PolicyContext): RuleCheck {
  const { author } = ctx.message;
  if (author !== "AGENT") return skip(`written by ${author.startsWith("BROKER:") ? "the firm" : author.toLowerCase()}: the rule only stops the agent`);
  const taken = controlAt(ctx.operation, atSim(ctx)) === "BROKER" || (sending(ctx) && ctx.operation.control === "BROKER");
  return taken ? deny("the firm has taken the conversation: the agent does not send") : pass("the agent has the conversation");
}

/** `CP-KIND-CHANNEL`: the matrix of docs/design-brief.md §3. */
export function checkKindChannel(ctx: PolicyContext): RuleCheck {
  const { kind, responsibles } = ctx.message;
  if (kind === undefined) return missing(ctx, "the message kind");
  const to = recipientText(ctx.route);
  if (!KIND_ROUTES[kind].includes(ctx.route)) return deny(`${kind} never goes to ${to}`);
  if (kind === "CORRECTION_REQUEST" && ctx.route === TO_IMPORTER) {
    if (responsibles === undefined) return sending(ctx) ? deny("a correction request to the importer needs the responsible of its observations") : pass(`${kind} goes to ${to}; the responsible is not rebuilt for a past instant`);
    if (responsibles.length === 0 || responsibles.some((party) => party !== "IMPORTER")) return deny("a correction request goes to the importer only when the importer is responsible");
  }
  return pass(`${kind} goes to ${to}`);
}

function samePhone(a: string, b: string): boolean {
  try {
    return normalizePhone(a) === normalizePhone(b);
  } catch {
    return false;
  }
}

/**
 * `CP-RECIPIENT-FENCE`: the verdict of outbound/recipient-fence.ts for the caller's sender profile
 * (docs/architecture-integrations.md §1). A WhatsApp without one is fenced to the registered phone of
 * the operation's importer, the only recipient `send_whatsapp` has (`LAM-RECIPIENT`).
 */
export function checkFence(ctx: PolicyContext): RuleCheck {
  const { fence } = ctx.input;
  if (fence !== undefined) return fence.allowed ? pass(fence.detail ?? "the recipient is inside the fence of its sender profile") : deny(fence.detail ?? "the recipient is outside the fence of its sender profile");
  const { to } = ctx.message;
  const phone = ctx.input.importer?.phoneE164;
  if (ctx.toImporterByWhatsApp && to !== undefined && phone !== undefined) {
    return samePhone(to, phone) ? pass("the WhatsApp goes to the importer's registered phone") : deny("the WhatsApp does not go to the importer's registered phone");
  }
  return missing(ctx, "the recipient fence verdict");
}

function importerOfOperation(ctx: PolicyContext): boolean {
  const { importer } = ctx.input;
  return importer === undefined || importer.importerId === ctx.operation.importerId;
}

function consentEntry(ctx: PolicyContext) {
  const consent = ctx.input.importer?.consent;
  return consent === undefined ? undefined : entryAt(consent.history, atSim(ctx));
}

/** `CP-OPTIN`: WhatsApp needs an opt-in registered by the instant (its revocation is `CP-OPTOUT`'s). */
export function checkOptIn(ctx: PolicyContext): RuleCheck {
  if (!ctx.toImporterByWhatsApp) return skip("the WhatsApp opt-in only applies to WhatsApp to the importer");
  if (!importerOfOperation(ctx)) return deny("the opt-in given is not the operation's importer's");
  const entry = consentEntry(ctx);
  if (entry === undefined) return deny("the importer has no WhatsApp opt-in");
  return pass(entry.action === "GRANTED" ? `WhatsApp opt-in in force since ${entry.atSim}` : "WhatsApp opt-in registered; its revocation is decided by CP-OPTOUT");
}

/** `CP-OPTOUT`: after an opt-out only the opt-out confirmation goes out. */
export function checkOptOut(ctx: PolicyContext): RuleCheck {
  if (!ctx.toImporterByWhatsApp) return skip("the opt-out only applies to WhatsApp to the importer");
  const optedOut = consentEntry(ctx)?.action === "REVOKED" || (sending(ctx) && ctx.input.importer?.consent?.revokedAt !== undefined);
  if (!optedOut) return pass("no opt-out in force");
  if (ctx.message.kind === OPT_OUT_CONFIRMATION) return pass("the opt-out confirmation is the one WhatsApp that follows an opt-out");
  return deny("the importer opted out of WhatsApp notices");
}

/** `CP-SUPPLIER-AUTH`: the importer's authorization and a contact of the operation's supplier someone confirmed. */
export function checkSupplierAuth(ctx: PolicyContext): RuleCheck {
  if (!ctx.toSupplierByEmail) return skip("the supplier authorization only applies to email to the supplier");
  const { supplier, contact, importer } = ctx.input;
  const { supplierId } = ctx.operation;
  if (supplier !== undefined && supplier.supplierId !== supplierId) return deny("the supplier given is not the operation's supplier");
  if (!importerOfOperation(ctx)) return deny("the authorization given is not the operation's importer's");
  const authorization = importer?.authorization;
  const authorized = authorizationActiveAt(authorization, atSim(ctx)) && !(sending(ctx) && authorization?.authorized === false);
  if (!authorized) return deny("the importer has not authorized the agent to write to this supplier");
  if (contact === undefined) return deny("the email has no registered contact of the supplier");
  if (contact.supplierId !== supplierId) return deny("the contact is not a contact of the operation's supplier");
  if (ctx.message.contactId !== undefined && ctx.message.contactId !== contact.contactId) return deny("the contact given is not the message's contact");
  const at = ctx.simNow.getTime();
  const everConfirmed = contact.statusHistory.some((entry) => entry.status === "ACTIVE" && Date.parse(entry.atSim) <= at);
  if (!everConfirmed || (sending(ctx) && contact.status === "PENDING_CONFIRMATION")) return deny("the contact was never confirmed: only an ACTIVE contact is written to");
  return pass("authorized by the importer, to a confirmed contact of the operation's supplier");
}

/** `CP-BOUNCED-CONTACT`: a bounced or complained contact is never used again. */
export function checkBouncedContact(ctx: PolicyContext): RuleCheck {
  if (!ctx.toSupplierByEmail) return skip("the contact status only applies to email to the supplier");
  const { contact } = ctx.input;
  if (contact === undefined) return skip("no contact to guest (CP-SUPPLIER-AUTH)");
  const dated = contactStatusAt(contact, atSim(ctx));
  const status = dated === "BOUNCED" || dated === "COMPLAINED" ? dated : sending(ctx) && (contact.status === "BOUNCED" || contact.status === "COMPLAINED") ? contact.status : undefined;
  return status === undefined ? pass("the contact has not bounced or complained") : deny(`the contact ${status === "BOUNCED" ? "bounced" : "complained"}: it is never written to again`);
}

/** `CP-APPROVED-SCOPE`: an approved dossier asks nobody for anything. */
export function checkApprovedScope(ctx: PolicyContext): RuleCheck {
  const approved = dossierStatusAt(ctx.operation, atSim(ctx)) === "APPROVED" || (sending(ctx) && ctx.operation.dossierStatus === "APPROVED");
  if (!approved) return pass("the dossier is not approved");
  const { kind, counterpart } = ctx.message;
  if (counterpart === "FIRM") return pass("a notice to the firm's own mailbox asks no party for anything");
  if (counterpart === "SUPPLIER") return deny("nothing goes to the supplier once the dossier is approved");
  if (kind !== undefined && APPROVED_IMPORTER_KINDS.includes(kind)) return pass(`${kind} still goes to the importer of an approved dossier`);
  if (kind === "REPLY") {
    if (ctx.reply === undefined) return missing(ctx, "the importer's message history");
    if (ctx.reply) return pass("a reply to the importer's own message, inside the window it opened");
  }
  return deny("an approved dossier only sends the importer the approval notice, the dispatch status, the opt-out confirmation and replies to the importer's own messages");
}

/** `CP-NO-SENSITIVE-ASK`: no text asks for identity, bank or card data or credentials (copy/forbidden.ts). */
export function checkSensitiveAsk(ctx: PolicyContext): RuleCheck {
  if (!sending(ctx)) return skip("content is checked when the message is sent");
  const { text, template } = ctx.message;
  const texts = [...(text === undefined ? [] : [text]), ...(template?.params ?? [])];
  if (texts.length === 0) return pass("no free text to read");
  for (const candidate of texts) {
    const ask = findSensitiveAsk(candidate);
    if (ask !== undefined) return deny(`the text asks for "${ask.term}": documents go by the upload link or by email`);
  }
  return pass("the text asks for no identity, bank or card data");
}

/** `CP-NO-FOREIGN-LINKS`: the verdict of outbound/verify.ts on the free text. */
export function checkForeignLinks(ctx: PolicyContext): RuleCheck {
  if (!sending(ctx)) return skip("content is checked when the message is sent");
  if (ctx.message.text === undefined) return pass("no free text: a template carries only its approved body");
  const verdict = ctx.input.foreignLinks;
  if (verdict === undefined) return skip("checked by outbound/verify.ts on the rendered text");
  return verdict.allowed ? pass(verdict.detail ?? "no link or contact outside the turn's") : deny(verdict.detail ?? "the text carries a link or a contact that is not the turn's");
}

export { checkWorldQuota } from "./world-quota";
