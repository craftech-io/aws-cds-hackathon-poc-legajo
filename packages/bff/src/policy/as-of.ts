// The policy at a past instant (docs/build-plan.md WP-17, docs/architecture.md §12): a message that
// already went out, decided at its own `sentAtSim`/`sentAtReal` with the rows as they are now, whose
// dated histories (control, dossier status, opt-in, supplier authorization, contact status) rebuild
// what was in force then. A revocation, a bounce or a takeover recorded after the send never makes it
// a breach; one that was in force when it went out always does. The WhatsApp window runs on the
// clock the message itself ran on (`simulated`). What only exists at send time is not re-checked:
// the recipient fence of an email (the SES client checked it) and the content rules (the audit never
// reads a body). `PolicyAudit` (check b) and the seed invariants (docs/seed-spec.md invariant 10)
// read the result; neither ever reads the machine's clock.
import { type Party, TurnTrigger } from "@legajo/shared";
import type { Message } from "../domain/conversations";
import type { Operation } from "../domain/operations";
import type { Consent, Importer, Supplier, SupplierAuthorization, SupplierContact } from "../domain/parties";
import { type EvaluateOptions, evaluateIn } from "./engine";
import type { PolicyHolidays } from "./holidays";
import type { PolicyDecision, PolicyInput } from "./types";

type HistoryRow = Pick<Message, "messageId" | "direction" | "channel" | "counterpart" | "status" | "sentAtSim" | "sentAtReal"> & Partial<Pick<Message, "kind" | "importerId" | "contactId">>;

export interface AsOfFacts {
  readonly message: Pick<Message, "messageId" | "channel" | "counterpart" | "author" | "sentAtSim" | "sentAtReal"> & Partial<Pick<Message, "kind" | "to" | "contactId" | "template" | "simulated">>;
  /** `trigger` of the send's `ALLOW` decision: tells a reply to the importer from a proactive send. */
  readonly trigger?: string;
  /** The importer's message the send answered, when the decision recorded it. */
  readonly answers?: string;
  /** `responsibleParty` of the observations a `CORRECTION_REQUEST` named. */
  readonly responsibles?: readonly Party[];
  readonly operation: Pick<Operation, "operationId" | "importerId" | "supplierId" | "controlHistory" | "dossierHistory">;
  readonly importer?: Pick<Importer, "phoneE164">;
  readonly consent?: Pick<Consent, "history">;
  readonly authorization?: Pick<SupplierAuthorization, "history">;
  readonly contact?: Pick<SupplierContact, "contactId" | "supplierId" | "statusHistory">;
  readonly supplier?: Pick<Supplier, "supplierId" | "timezone">;
  /** National holidays of Argentina (`Reference/REF#HOLIDAY#AR`). */
  readonly holidays?: PolicyHolidays;
  /** The counterpart's messages around the send (any operation). */
  readonly history?: readonly HistoryRow[];
}

function asOfInput(facts: AsOfFacts): PolicyInput {
  const { message, operation } = facts;
  const trigger = TurnTrigger.safeParse(facts.trigger);
  return {
    message: {
      messageId: message.messageId,
      channel: message.channel,
      counterpart: message.counterpart,
      kind: message.kind,
      author: message.author,
      to: message.to,
      contactId: message.contactId,
      template: message.template,
      trigger: trigger.success ? trigger.data : undefined,
      answers: facts.answers,
      responsibles: facts.responsibles === undefined ? undefined : [...facts.responsibles],
    },
    operation: { operationId: operation.operationId, importerId: operation.importerId, supplierId: operation.supplierId, controlHistory: operation.controlHistory, dossierHistory: operation.dossierHistory },
    importer: { importerId: operation.importerId, phoneE164: facts.importer?.phoneE164, consent: facts.consent, authorization: facts.authorization },
    supplier: facts.supplier,
    contact: facts.contact,
    history: facts.history === undefined ? undefined : [...facts.history],
    clock: { simNow: message.sentAtSim, realNow: message.sentAtReal },
    // Email is always live; WhatsApp ran on the clock the message itself was sent on.
    modes: { email: "live", whatsapp: message.simulated === true ? "simulated" : "live" },
    holidays: facts.holidays,
  };
}

/** The policy of the instant `message` went out; `exhaustive` lists every rule it breached. */
export function evaluateAsOf(facts: AsOfFacts, options: EvaluateOptions = {}): PolicyDecision {
  return evaluateIn("AS_OF", asOfInput(facts), options);
}
