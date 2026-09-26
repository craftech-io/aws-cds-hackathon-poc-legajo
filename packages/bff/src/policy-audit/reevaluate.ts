// Check (b) of `PolicyAudit` (docs/architecture.md §12): the contact policy re-evaluated with the
// data of the moment a message went out, rebuilt from the dated histories the connector keeps
// (consent, supplier authorization, contact status, control and dossier status; §5), the kind →
// channel matrix and the time rules of time-rules.ts. A revocation, a bounce or a takeover that
// happened after the send never makes a past send a violation, and one that was in force when it
// went out always does. `CP-RECIPIENT-FENCE`, `CP-NO-SENSITIVE-ASK` and `CP-NO-FOREIGN-LINKS` check
// addresses and text at send time (outbound/) and are not re-evaluated from stored messages.
import type { Channel, ContactPolicyRuleId, MessageKind } from "@legajo/shared";
import type { Counterpart, Message } from "../domain/conversations";
import { controlAt, dossierStatusAt, type Operation } from "../domain/operations";
import { type Consent, type SupplierAuthorization, type SupplierContact, authorizationActiveAt, contactStatusAt } from "../domain/parties";
import { entryAt } from "../domain/common";
import { TIME_RULES, type TimeFacts, timeBreaches } from "./time-rules";

/** What the send looked like when it went out: the message and the rows whose histories decide it. */
export interface SendFacts extends Omit<TimeFacts, "message"> {
  readonly message: Pick<Message, "channel" | "counterpart" | "kind" | "author" | "sentAtSim"> & Partial<TimeFacts["message"]>;
  readonly operation: Pick<Operation, "controlHistory" | "dossierHistory">;
  /** WhatsApp opt-in of the operation's importer. */
  readonly consent?: Pick<Consent, "history">;
  /** The importer's authorization to write to the operation's supplier. */
  readonly authorization?: Pick<SupplierAuthorization, "history">;
  /** The supplier contact the email went to. */
  readonly contact?: Pick<SupplierContact, "statusHistory">;
}

export interface RuleBreach {
  readonly ruleId: ContactPolicyRuleId;
  readonly detail: string;
}

/** Re-evaluated rules, in the engine's order (docs/design-brief.md §5.7). */
export const REEVALUATED_RULES = [
  "CP-CONTROL-BROKER",
  "CP-KIND-CHANNEL",
  "CP-OPTIN",
  "CP-OPTOUT",
  "CP-SUPPLIER-AUTH",
  "CP-BOUNCED-CONTACT",
  "CP-APPROVED-SCOPE",
  ...TIME_RULES,
] as const satisfies readonly ContactPolicyRuleId[];

type Route = `${Counterpart}:${Channel}`;
const TO_IMPORTER: Route = "IMPORTER:WHATSAPP";
const TO_SUPPLIER: Route = "SUPPLIER:EMAIL";

/** Kind → recipient and channel (docs/design-brief.md §3; `send_email` also answers a supplier with `REPLY`). */
const KIND_ROUTES: Readonly<Record<MessageKind, readonly Route[]>> = {
  DOCS_REQUEST: [TO_IMPORTER, TO_SUPPLIER],
  REMINDER: [TO_IMPORTER, TO_SUPPLIER],
  CORRECTION_REQUEST: [TO_IMPORTER, TO_SUPPLIER],
  NO_ACTION_NEEDED: [TO_IMPORTER],
  CONTACT_REQUEST: [TO_IMPORTER],
  CONTACT_CONFIRMATION: [TO_IMPORTER],
  UPLOAD_LINK: [TO_IMPORTER],
  ETA_CHANGE: [TO_IMPORTER, TO_SUPPLIER],
  ESCALATION_NOTICE: [TO_IMPORTER],
  ESCALATION: ["FIRM:EMAIL"],
  APPROVAL_NOTICE: [TO_IMPORTER],
  DISPATCH_STATUS: [TO_IMPORTER],
  REPLY: [TO_IMPORTER, TO_SUPPLIER],
  BROKER_MESSAGE: [TO_IMPORTER],
  OPT_OUT_CONFIRMATION: [TO_IMPORTER],
  OPERATION_CHOICE: [TO_IMPORTER],
};

/** The fixed opt-out confirmation is exempt from the opt-in rules and from the approved scope. */
const OPT_OUT_CONFIRMATION: MessageKind = "OPT_OUT_CONFIRMATION";

/** What an approved dossier may still send to the importer. */
const APPROVED_IMPORTER_KINDS: readonly MessageKind[] = ["APPROVAL_NOTICE", "DISPATCH_STATUS", OPT_OUT_CONFIRMATION];

function controlBreach(facts: SendFacts, atSim: string): RuleBreach | undefined {
  if (facts.message.author !== "AGENT") return undefined;
  return controlAt(facts.operation, atSim) === "BROKER" ? { ruleId: "CP-CONTROL-BROKER", detail: "the agent wrote while the firm had the conversation" } : undefined;
}

function kindChannelBreach(facts: SendFacts): RuleBreach | undefined {
  const { message } = facts;
  if (message.kind === undefined) return undefined;
  const route: Route = `${message.counterpart}:${message.channel}`;
  return KIND_ROUTES[message.kind].includes(route) ? undefined : { ruleId: "CP-KIND-CHANNEL", detail: `${message.kind} does not go to ${route}` };
}

function optInBreach(facts: SendFacts, atSim: string): RuleBreach | undefined {
  const { message } = facts;
  if (message.channel !== "WHATSAPP" || message.counterpart !== "IMPORTER" || message.kind === OPT_OUT_CONFIRMATION) return undefined;
  const entry = facts.consent === undefined ? undefined : entryAt(facts.consent.history, atSim);
  if (entry === undefined) return { ruleId: "CP-OPTIN", detail: "no WhatsApp opt-in in force when the message went out" };
  return entry.action === "REVOKED" ? { ruleId: "CP-OPTOUT", detail: "the importer had opted out when the message went out" } : undefined;
}

function supplierBreach(facts: SendFacts, atSim: string): RuleBreach | undefined {
  const { message } = facts;
  if (message.channel !== "EMAIL" || message.counterpart !== "SUPPLIER") return undefined;
  if (!authorizationActiveAt(facts.authorization, atSim)) return { ruleId: "CP-SUPPLIER-AUTH", detail: "the importer had not authorized contact with the supplier" };
  const status = facts.contact === undefined ? undefined : contactStatusAt(facts.contact, atSim);
  if (status === "BOUNCED" || status === "COMPLAINED") return { ruleId: "CP-BOUNCED-CONTACT", detail: `the contact was ${status.toLowerCase()} when the email went out` };
  return status === "ACTIVE" ? undefined : { ruleId: "CP-SUPPLIER-AUTH", detail: "the contact was not confirmed when the email went out" };
}

function approvedScopeBreach(facts: SendFacts, atSim: string): RuleBreach | undefined {
  if (dossierStatusAt(facts.operation, atSim) !== "APPROVED") return undefined;
  const { message } = facts;
  if (message.counterpart === "SUPPLIER") return { ruleId: "CP-APPROVED-SCOPE", detail: "nothing goes to the supplier once the dossier is approved" };
  if (message.counterpart === "IMPORTER" && (message.kind === undefined || !APPROVED_IMPORTER_KINDS.includes(message.kind))) {
    return { ruleId: "CP-APPROVED-SCOPE", detail: "an approved dossier only sends the approval notice and the dispatch status" };
  }
  return undefined;
}

/** The time rules need the message's id, instants and form; without them they are not re-evaluated. */
function timeFactsOf(facts: SendFacts): TimeFacts | undefined {
  const { message } = facts;
  if (message.messageId === undefined || message.direction === undefined || message.status === undefined || message.sentAtReal === undefined) return undefined;
  return {
    ...facts,
    message: { ...message, messageId: message.messageId, direction: message.direction, status: message.status, sentAtReal: message.sentAtReal, simulated: message.simulated ?? false },
  };
}

/** Every re-evaluated rule the send breaks at `sentAtSim`; empty when the policy would allow it again. */
export function reevaluateSend(facts: SendFacts): RuleBreach[] {
  const atSim = facts.message.sentAtSim;
  const breaches = [controlBreach, kindChannelBreach, optInBreach, supplierBreach, approvedScopeBreach].flatMap((rule) => {
    const breach = rule(facts, atSim);
    return breach === undefined ? [] : [breach];
  });
  const time = timeFactsOf(facts);
  return time === undefined ? breaches : [...breaches, ...timeBreaches(time)];
}
