// `escalate_to_broker` without the tool wrapper (docs/tool-catalog.md, docs/design-brief.md §5.8): what
// the `handoff` target runs for the agent (`OUT_OF_CHECKLIST`, `IMPORTER_ASKED`, `OTHER`) and for the
// worker (every deterministic reason), and what the `ESCALATION`/`ARRIVAL` milestones and the
// `CONTACT_CHECK` timer run in process. In order:
//
//   1. one OPEN escalation per reason and operation (`openEscalation`): a second call answers the
//      open one and sends nothing new;
//   2. for `IMPORTER_ASKED`, `MISSING_AT_ETA_48H`, `OBSERVATION_ATTEMPTS`, `UNTRUSTED_SENDER` and
//      `NO_VALID_CONTACT`, the email to `Firm.mailboxAddress` from `avisos@` through the pipeline
//      (counterpart FIRM: the dossier, what was tried, who owes what, the labelled risk); the
//      `UNTRUSTED_SENDER` emails of a firm stop at `FirmSettings.untrustedSenderEmailsPerDay` per real
//      day (the rest stay in the console);
//   3. `notifyImporter`: the approved template `legajo_escalado` to the importer through the pipeline
//      (policy, hours and window included: it may be deferred).
//
// The message ids are derived from the escalation, so a retried event that finds its escalation open
// replays the same sends instead of repeating them. The caller audits the decision.
import type { EscalationReason, TurnTrigger } from "@legajo/shared";
import { firmEsAR } from "../copy/es-AR-firm";
import type { Actor } from "../domain/common";
import type { Escalation, Operation } from "../domain/operations";
import type { DecisionRefs } from "../domain/audit";
import type { OutboundCall, OutboundResult } from "../outbound/types";
import { type EscalationDeps, derivedMessageId } from "./ports";
import { escalationReport } from "./report";

/** Reasons whose escalation also emails the firm's mailbox (docs/tool-catalog.md `escalate_to_broker`). */
export const FIRM_EMAIL_REASONS: ReadonlySet<EscalationReason> = new Set(["IMPORTER_ASKED", "MISSING_AT_ETA_48H", "OBSERVATION_ATTEMPTS", "UNTRUSTED_SENDER", "NO_VALID_CONTACT"]);

export interface EscalateInput {
  readonly operation: Operation;
  readonly reason: EscalationReason;
  /** At most 500 characters, without personal data. */
  readonly summary: string;
  readonly notifyImporter?: boolean;
  readonly actor: Actor;
  /** Simulated instant of the decision (the turn's event, the timer's `eventAtSim`). */
  readonly atSim: string;
  readonly trigger?: TurnTrigger;
  readonly turnId?: string;
  readonly correlationId: string;
  readonly refs?: DecisionRefs;
  readonly observationId?: string;
  readonly docVersionId?: string;
}

export type FirmEmailOutcome = "SENT" | "DEFERRED" | "REFUSED" | "CAPPED" | "NOT_NEEDED" | "ALREADY_SENT";

export interface Escalated {
  readonly escalation: Escalation;
  readonly created: boolean;
  readonly emailSent: boolean;
  readonly firmEmail: FirmEmailOutcome;
  readonly importerNotice?: OutboundResult["status"];
}

/** Real day (UTC) of the `UNTRUSTED_SENDER` email cap. */
export function untrustedCapCounter(firmId: string, realNow: Date): string {
  return `UNTRUSTED_MAIL#${firmId}#${realNow.toISOString().slice(0, 10)}`;
}

function callOf(input: EscalateInput, deps: EscalationDeps): OutboundCall {
  return { actor: input.actor, correlationId: input.correlationId, log: deps.log, refs: { ...(input.refs ?? {}), operationId: input.operation.operationId } };
}

async function underCap(input: EscalateInput, deps: EscalationDeps): Promise<boolean> {
  if (input.reason !== "UNTRUSTED_SENDER") return true;
  const settings = await deps.data.firms.getSettings(input.operation.firmId);
  const count = await deps.data.runtime.incrementCounter(untrustedCapCounter(input.operation.firmId, deps.wallClock()));
  return count <= settings.untrustedSenderEmailsPerDay;
}

async function emailFirm(escalation: Escalation, retried: boolean, input: EscalateInput, deps: EscalationDeps): Promise<FirmEmailOutcome> {
  if (!FIRM_EMAIL_REASONS.has(input.reason)) return "NOT_NEEDED";
  if (escalation.emailSent) return "ALREADY_SENT";
  const messageId = derivedMessageId("ESC", input.operation.operationId, escalation.escalationId, "FIRM");
  // A retry whose email was already decided replays it without counting it against the cap again.
  const decided = retried && (await deps.data.conversations.getMessage(input.operation.operationId, messageId)) !== undefined;
  if (!decided && !(await underCap(input, deps))) {
    deps.log.info("escalation.email_capped", { reason: input.reason, operationId: input.operation.operationId });
    return "CAPPED";
  }
  const params = await escalationReport(deps, { operation: input.operation, reason: input.reason, summary: escalation.summary, nowSim: input.atSim });
  const email = firmEsAR.escalationEmail(params);
  const result = await deps.send(
    {
      channel: "EMAIL",
      counterpart: "FIRM",
      operationId: input.operation.operationId,
      kind: "ESCALATION",
      author: "SYSTEM",
      textSource: "CODE",
      eventAtSim: input.atSim,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      subject: email.subject,
      text: email.body,
      messageId,
    },
    callOf(input, deps),
  );
  if (result.status === "SENT") await deps.data.operations.markEscalationEmailed(input.operation.operationId, escalation.escalationId);
  return result.status;
}

async function noticeImporter(escalation: Escalation, input: EscalateInput, deps: EscalationDeps): Promise<OutboundResult["status"]> {
  const firm = await deps.data.firms.getFirm(input.operation.firmId);
  const result = await deps.send(
    {
      channel: "WHATSAPP",
      operationId: input.operation.operationId,
      kind: "ESCALATION_NOTICE",
      author: input.actor,
      textSource: "CODE",
      eventAtSim: input.atSim,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      template: { name: "legajo_escalado", params: [input.operation.operationNumber, firm.name] },
      messageId: derivedMessageId("ESC", input.operation.operationId, escalation.escalationId, "IMPORTER"),
    },
    callOf(input, deps),
  );
  return result.status;
}

/** Steps 1 to 3; never throws for a refused send (the escalation exists either way). */
export async function escalate(input: EscalateInput, deps: EscalationDeps): Promise<Escalated> {
  const { operation } = input;
  const { escalation, created } = await deps.data.operations.openEscalation({
    operationId: operation.operationId,
    firmId: operation.firmId,
    clockId: operation.clockId,
    reason: input.reason,
    summary: [...input.summary].slice(0, 500).join(""),
    openedAtSim: input.atSim,
    openedAtReal: deps.wallClock().toISOString(),
    openedBy: input.actor,
    emailSent: false,
    notifyImporter: input.notifyImporter === true,
    ...(input.observationId === undefined ? {} : { observationId: input.observationId }),
    ...(input.docVersionId === undefined ? {} : { docVersionId: input.docVersionId }),
  });
  // The same decision retried (same simulated instant): finish what the first attempt may have left.
  const retried = !created && Date.parse(escalation.openedAtSim) === Date.parse(input.atSim);
  if (!created && !retried) return { escalation, created, emailSent: escalation.emailSent, firmEmail: escalation.emailSent ? "ALREADY_SENT" : "NOT_NEEDED" };
  const firmEmail = await emailFirm(escalation, retried, input, deps);
  const notify = created ? input.notifyImporter === true : escalation.notifyImporter;
  const importerNotice = notify ? await noticeImporter(escalation, input, deps) : undefined;
  return { escalation, created, emailSent: firmEmail === "SENT" || firmEmail === "ALREADY_SENT", firmEmail, ...(importerNotice === undefined ? {} : { importerNotice }) };
}
