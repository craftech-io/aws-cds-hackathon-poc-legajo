// Escalations decided by code around a dossier's documents and contacts (docs/design-brief.md §5.8):
//
//   OBSERVATION_ATTEMPTS    a corrected version came back with the same observation for the second time
//   UNRECOGNIZED_DOCUMENT   the reader did not recognize a PDF (ADR-0003: the firm classifies it)
//   READER_UNAVAILABLE      the reader failed three readings of the same version (FL-096)
//   NO_VALID_CONTACT        a day after a permanent bounce, the supplier has no ACTIVE confirmed contact (FL-030)
//
// Each rule is pure and says whether the reason also mails the firm's mailbox (the list of
// docs/tool-catalog.md `escalate_to_broker`). The summary is composed from copy/ only and carries no
// personal data. `recordEscalation` opens one and audits it: by default the `Operations/ESC#` row alone
// (one OPEN per reason and operation); the worker passes `escalationsOpener`, which opens it through the
// escalations module and so also mails the firm for the reasons that need it (with its caps).
import type { EscalationReason } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import { FIRM_EMAIL_REASONS, escalate } from "../escalations/escalate";
import type { EscalationDeps } from "../escalations/ports";
import type { DocumentVersion, Observation } from "../domain/documents";
import type { Escalation, Operation } from "../domain/operations";
import { type SupplierContact, contactStatusAt } from "../domain/parties";
import { capitalize } from "../copy/helpers";
import { labelsEsAR } from "../copy/es-AR";
import { correctionTargetEsAR } from "../copy/observation-labels";
import type { Escalate, EscalationRequest } from "./ports";

/** Correction requests of one observation that may fail before it escalates (CONTEXT.md "Intento"). */
export const ATTEMPT_LIMIT = 2;

/** Failed readings of one version before `READER_UNAVAILABLE` (docs/architecture-integrations.md §5). */
export const READER_FAILURES_TO_ESCALATE = 3;

type OperationRef = EscalationRequest["operation"];

function summaryOf(reason: EscalationReason, detail?: string): string {
  const label = capitalize(labelsEsAR.escalationReason[reason]);
  return (detail === undefined ? label : `${label}: ${detail}`).slice(0, 500);
}

function request(reason: EscalationReason, operation: OperationRef, atSim: string, detail: string | undefined, refs: Pick<EscalationRequest, "observationId" | "docVersionId"> = {}): EscalationRequest {
  return { reason, operation, summary: summaryOf(reason, detail), atSim, notifyFirm: FIRM_EMAIL_REASONS.has(reason), ...refs };
}

/** The observation reached its attempt limit: it escalates and the agent stops asking for it. */
export function observationAttemptsEscalation(operation: OperationRef, observation: Pick<Observation, "observationId" | "code" | "docType" | "attempts">, docVersionId: string, atSim: string): EscalationRequest | undefined {
  if (observation.attempts < ATTEMPT_LIMIT) return undefined;
  return request("OBSERVATION_ATTEMPTS", operation, atSim, correctionTargetEsAR(observation.code, observation.docType), { observationId: observation.observationId, docVersionId });
}

/** A version the reader did not recognize goes to the firm, who classifies or discards it. */
export function unrecognizedEscalation(operation: OperationRef, version: Pick<DocumentVersion, "docVersionId" | "source">, atSim: string): EscalationRequest {
  return request("UNRECOGNIZED_DOCUMENT", operation, atSim, labelsEsAR.party[version.source.party], { docVersionId: version.docVersionId });
}

/** The third failed reading of a version escalates once; later retries keep trying quietly. */
export function readerUnavailableEscalation(operation: OperationRef, version: Pick<DocumentVersion, "docVersionId" | "docType">, failures: number, atSim: string): EscalationRequest | undefined {
  if (failures !== READER_FAILURES_TO_ESCALATE) return undefined;
  return request("READER_UNAVAILABLE", operation, atSim, labelsEsAR.docType[version.docType], { docVersionId: version.docVersionId });
}

/** A contact the agent may write to at `atSim`: ACTIVE then and confirmed by someone before it. */
export function isValidContactAt(contact: Pick<SupplierContact, "statusHistory" | "confirmedAt">, atSim: string): boolean {
  return contactStatusAt(contact, atSim) === "ACTIVE" && contact.confirmedAt !== undefined && Date.parse(contact.confirmedAt) <= Date.parse(atSim);
}

/** `TIMER#CONTACT_CHECK` (FL-030): without a valid contact of the operation's supplier, the firm takes over. */
export function noValidContactEscalation(operation: OperationRef, contacts: readonly Pick<SupplierContact, "statusHistory" | "confirmedAt">[], atSim: string): EscalationRequest | undefined {
  if (contacts.some((contact) => isValidContactAt(contact, atSim))) return undefined;
  return request("NO_VALID_CONTACT", operation, atSim, undefined);
}

/** Opens an escalation: one OPEN per reason and operation, `created` only the first time. */
export type EscalationOpener = (input: EscalationRequest) => Promise<{ readonly escalation: Escalation; readonly created: boolean }>;

function connectorOpener(connector: Pick<Connector, "operations">): EscalationOpener {
  return (input) =>
    connector.operations.openEscalation({
      operationId: input.operation.operationId,
      firmId: input.operation.firmId,
      clockId: input.operation.clockId,
      reason: input.reason,
      summary: input.summary,
      openedAtSim: input.atSim,
      openedBy: "SYSTEM",
      ...(input.observationId === undefined ? {} : { observationId: input.observationId }),
      ...(input.docVersionId === undefined ? {} : { docVersionId: input.docVersionId }),
    });
}

/** The escalations module's `escalate` (`caller WORKER`): the row, and the firm's email when `notifyFirm`. */
export function escalationsOpener(deps: EscalationDeps, correlationId: string): EscalationOpener {
  return async (input) => {
    const operation = await deps.data.operations.getOperation(input.operation.operationId);
    const escalated = await escalate(
      {
        operation,
        reason: input.reason,
        summary: input.summary,
        actor: "SYSTEM",
        atSim: input.atSim,
        correlationId,
        ...(input.observationId === undefined ? {} : { observationId: input.observationId }),
        ...(input.docVersionId === undefined ? {} : { docVersionId: input.docVersionId }),
      },
      deps,
    );
    return { escalation: escalated.escalation, created: escalated.created };
  };
}

/** Opens the escalation with `open` and records `ACTION ESCALATION_OPENED` the first time. */
export function recordEscalation(connector: Pick<Connector, "operations" | "audit">, wallClock: () => Date, open: EscalationOpener = connectorOpener(connector)): Escalate {
  return async (input) => {
    const { operation } = input;
    const { escalation, created } = await open(input);
    if (created) {
      await connector.audit.record({
        firmId: operation.firmId,
        decision: "ACTION",
        action: "ESCALATION_OPENED",
        actor: "SYSTEM",
        reason: input.reason,
        refs: {
          operationId: operation.operationId,
          escalationId: escalation.escalationId,
          ...(input.observationId === undefined ? {} : { observationId: input.observationId }),
          ...(input.docVersionId === undefined ? {} : { docVersionId: input.docVersionId }),
        },
        clockId: operation.clockId,
        operationId: operation.operationId,
        atSim: input.atSim,
        atReal: wallClock().toISOString(),
        detail: { notifyFirm: input.notifyFirm },
      });
    }
    return { escalationId: escalation.escalationId, created };
  };
}

/** Operation fields an escalation request carries. */
export function operationRef(operation: Operation): OperationRef {
  return { operationId: operation.operationId, operationNumber: operation.operationNumber, firmId: operation.firmId, clockId: operation.clockId };
}
