// Check (b) of `PolicyAudit` (docs/architecture.md §12): the contact policy re-evaluated with the
// data of the moment a message went out, rebuilt from the dated histories the connector keeps
// (consent, supplier authorization, contact status, control and dossier status; §5). Only the rules
// whose facts live in those histories are re-evaluated here: a revocation, a bounce or a takeover
// that happened after the send never makes a past send a violation, and one that was in force when
// it went out always does.
import type { ContactPolicyRuleId, MessageKind } from "@legajo/shared";
import type { Message } from "../domain/conversations";
import { controlAt, dossierStatusAt, type Operation } from "../domain/operations";
import { type Consent, type SupplierAuthorization, type SupplierContact, authorizationActiveAt, contactStatusAt } from "../domain/parties";
import { entryAt } from "../domain/common";

/** What the send looked like when it went out: the message and the rows whose histories decide it. */
export interface SendFacts {
  readonly message: Pick<Message, "channel" | "counterpart" | "kind" | "author" | "sentAtSim">;
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
export const REEVALUATED_RULES = ["CP-CONTROL-BROKER", "CP-OPTIN", "CP-OPTOUT", "CP-SUPPLIER-AUTH", "CP-BOUNCED-CONTACT", "CP-APPROVED-SCOPE"] as const satisfies readonly ContactPolicyRuleId[];

/** The fixed opt-out confirmation is exempt from the opt-in rules and from the approved scope. */
const OPT_OUT_CONFIRMATION: MessageKind = "OPT_OUT_CONFIRMATION";

/** What an approved dossier may still send to the importer. */
const APPROVED_IMPORTER_KINDS: readonly MessageKind[] = ["APPROVAL_NOTICE", "DISPATCH_STATUS", OPT_OUT_CONFIRMATION];

function controlBreach(facts: SendFacts, atSim: string): RuleBreach | undefined {
  if (facts.message.author !== "AGENT") return undefined;
  return controlAt(facts.operation, atSim) === "BROKER" ? { ruleId: "CP-CONTROL-BROKER", detail: "the agent wrote while the firm had the conversation" } : undefined;
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

/** Every re-evaluated rule the send breaks at `sentAtSim`; empty when the policy would allow it again. */
export function reevaluateSend(facts: SendFacts): RuleBreach[] {
  const atSim = facts.message.sentAtSim;
  return [controlBreach, optInBreach, supplierBreach, approvedScopeBreach].flatMap((rule) => {
    const breach = rule(facts, atSim);
    return breach === undefined ? [] : [breach];
  });
}
