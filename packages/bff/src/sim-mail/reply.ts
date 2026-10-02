// One email of the supplier simulator through the single SES client, profile `SIMULATOR`
// (docs/architecture-integrations.md §1 and §3): from the supplier's mailbox that received our request
// (an ACTIVE contact of the operation's supplier, which the client's fence checks against `Parties`)
// to the operation's thread address, with `In-Reply-To` and `References` of what it answers, the
// configuration set `…-sim-poc`, the texts of copy/en-supplier-sim.ts and the template PDFs of the
// seed. The client writes the reply's own pending mail (`awaiting INBOUND`) before `SendEmail`.
// After a reply goes out, `Operations/META.simState` moves (versions sent, counters of the loop
// guard) and `AuditLog` gets `ACTION SIM_REPLY`.
import { ConnectorError, type SupplierBehaviour } from "@legajo/shared";
import type { SimulatorPurpose } from "../channels/email/fence";
import type { EmailClient, EmailSendResult } from "../channels/email/outbound";
import type { Connector } from "../connector/connector";
import { labelsEn, replySubject } from "../copy/en";
import { supplierSimEn } from "../copy/en-supplier-sim";
import type { EmailText } from "../copy/types";
import type { Operation } from "../domain/operations";
import type { Logger } from "../lib/log";
import { type PlannedPdf, type ReplyPlan, afterReply } from "./behaviour";
import { SIM_AUDIT_ACTIONS, SIM_REPLY_TAG } from "./config";
import type { SeedPdfStore } from "./seed-pdfs";

export interface ReplyDeps {
  readonly data: Pick<Connector, "operations" | "audit">;
  readonly email: Pick<EmailClient, "send">;
  readonly seed: SeedPdfStore;
  /** Real clock. */
  readonly now: () => Date;
  readonly log: Logger;
}

export type ReplyMode = "IMMEDIATE" | "TIMER" | "SEND_NOW";

export interface ReplyEnvelope {
  readonly mode: ReplyMode;
  readonly operation: Operation;
  readonly supplierName: string;
  /** The supplier's registered mailbox: the `From`. */
  readonly mailbox: string;
  /** The operation's thread address: the only recipient. */
  readonly threadAddress: string;
  readonly purpose: SimulatorPurpose;
  /** Subject of the email being answered. */
  readonly subject: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  /** Simulated instant of the reply (the timer's `dueAtSim`, or the world's now). */
  readonly atSim: string;
  /** `SEND_NOW` only: the mail id the `QaDriver` derived, and its own body. */
  readonly mailId?: string;
  readonly body?: string;
  readonly behaviour?: SupplierBehaviour;
  readonly timerKey?: string;
}

const MAX_REFERENCES = 50;
const MAX_STATE_ATTEMPTS = 3;

/** `packing-list-v2.pdf`, `document-1.pdf`: what a supplier would name the file (never seen by the model). */
export function attachmentName(pdf: PlannedPdf): string {
  if (pdf.source === "UNKNOWN") return `document-${pdf.index}.pdf`;
  return `${labelsEn.docType[pdf.docType].replaceAll(" ", "-")}-v${pdf.version}.pdf`;
}

function textOf(envelope: ReplyEnvelope, plan: ReplyPlan): EmailText {
  if (envelope.body !== undefined) return { subject: replySubject(envelope.subject), body: envelope.body };
  const params = { subject: envelope.subject, docTypes: plan.claimed, invoiceNumber: envelope.operation.invoiceNumber, supplierName: envelope.supplierName };
  switch (plan.body.kind) {
    case "DOCUMENTS":
      return supplierSimEn.documentsAttached(params);
    case "CORRECTED":
      return supplierSimEn.correctedAttached(params);
    case "PROMISE":
      return supplierSimEn.promise(params);
    case "AUTO_REPLY":
      return supplierSimEn.autoReply(params);
    case "INJECTION":
      return { subject: replySubject(envelope.subject), body: supplierSimEn.injectionBodies(envelope.operation.operationNumber)[plan.body.index] };
  }
}

async function bytesOf(seed: SeedPdfStore, operation: Operation, pdf: PlannedPdf): Promise<Uint8Array> {
  return pdf.source === "UNKNOWN" ? seed.readUnknown(pdf.index) : seed.read(operation.templateOperation, pdf.docType, pdf.version);
}

/** `simState` after the reply, pinned to the version read; a concurrent write is re-read and merged. */
async function recordState(deps: ReplyDeps, operationId: string, plan: ReplyPlan, atSim: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const current = await deps.data.operations.getOperation(operationId);
    try {
      await deps.data.operations.updateOperation(operationId, { simState: afterReply(current.simState, plan, atSim, deps.now()) }, current.version);
      return;
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT") || attempt >= MAX_STATE_ATTEMPTS) throw error;
    }
  }
}

async function audit(deps: ReplyDeps, envelope: ReplyEnvelope, action: string, detail: Record<string, unknown>, mailId?: string): Promise<void> {
  const { operation } = envelope;
  await deps.data.audit.record({
    firmId: operation.firmId,
    decision: "ACTION",
    action,
    actor: "SYSTEM",
    refs: { operationId: operation.operationId, ...(mailId === undefined ? {} : { mailId }), ...(envelope.timerKey === undefined ? {} : { timerKey: envelope.timerKey }) },
    clockId: operation.clockId,
    operationId: operation.operationId,
    atSim: envelope.atSim,
    atReal: deps.now().toISOString(),
    correlationId: deps.log.correlationId,
    detail: { mode: envelope.mode, ...(envelope.behaviour === undefined ? {} : { behaviour: envelope.behaviour }), ...detail },
  });
}

/** Sends one reply; a refusal of the fence comes back as `REFUSED` (the client already audited it). */
export async function sendReply(deps: ReplyDeps, envelope: ReplyEnvelope, plan: ReplyPlan): Promise<EmailSendResult> {
  const { operation } = envelope;
  const text = textOf(envelope, plan);
  const attachments = await Promise.all(plan.pdfs.map(async (pdf) => ({ filename: attachmentName(pdf), bytes: new Uint8Array(await bytesOf(deps.seed, operation, pdf)) })));
  let result: EmailSendResult;
  try {
    result = await deps.email.send({
      profile: "SIMULATOR",
      purpose: envelope.purpose,
      from: { address: envelope.mailbox, displayName: envelope.supplierName },
      to: envelope.threadAddress,
      subject: text.subject,
      text: text.body,
      lang: "en",
      ...(envelope.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo }),
      references: envelope.references.slice(-MAX_REFERENCES),
      clockId: operation.clockId,
      firmId: operation.firmId,
      operationId: operation.operationId,
      kind: SIM_REPLY_TAG,
      attachments,
      autoReply: plan.autoReply,
      actor: "SYSTEM",
      ...(envelope.mailId === undefined ? {} : { mailId: envelope.mailId }),
    });
  } catch (error) {
    await audit(deps, envelope, SIM_AUDIT_ACTIONS.replyFailed, { error: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
  if (result.status === "REFUSED") {
    deps.log.warn("simulated reply refused by the fence", { operationId: operation.operationId, code: result.code, reason: result.reason, mode: envelope.mode });
    return result;
  }
  if (envelope.mode !== "SEND_NOW") await recordState(deps, operation.operationId, plan, envelope.atSim);
  await audit(deps, envelope, SIM_AUDIT_ACTIONS.reply, { body: plan.body.kind, attachments: plan.pdfs.length, autoReply: plan.autoReply }, result.mailId);
  deps.log.info("simulated reply sent", { operationId: operation.operationId, mode: envelope.mode, body: plan.body.kind, attachments: plan.pdfs.length, mailId: result.mailId });
  return result;
}
