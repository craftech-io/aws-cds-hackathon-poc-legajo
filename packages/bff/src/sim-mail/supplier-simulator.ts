// The supplier simulator (docs/architecture-integrations.md §3, FL-088): what a supplier's simulated
// mailbox does with a request we sent it, once the guard proved the mail ours.
//
//   receipt     the loop guards (no reply to `Auto-Submitted` other than `no`, to anything but a live
//               thread address of the same operation, nor past 6 replies per operation and simulated
//               day or real day), then the behaviour's reaction: nothing (`NO_REPLY`), a
//               `TIMER#SIM_REPLY#` (`SIM_REPLY_SCHEDULED`), or an immediate text plus the timer of the
//               documents that follow (`SIM_REPLY_SENT`);
//   TIMER       a due `TIMER#SIM_REPLY#` (from ScheduleDispatch or advance_clock): the reply with its PDFs;
//   SEND_NOW    the `QaDriver`'s `supplier.sendNow`, QA worlds only: the operation's ACTIVE contact
//               writes the requested template PDFs to its thread address, chained to the last email of
//               the thread, without a pending request (FL-058, FL-069).
//
// Every email goes out through the single SES client with the `SIMULATOR` profile (reply.ts).
import { ConnectorError, DocType, ToolError, parseClockId, parseThreadAddress, type SupplierBehaviour } from "@legajo/shared";
import { AUTO_SUBMITTED_HEADER, OPERATION_HEADER, REQUEST_HEADER, isAutoSubmitted, parseLegajoRequest, parseOperationHeader } from "../channels/email/headers";
import type { ParsedMail } from "../channels/email/mime";
import type { ThreadResolution } from "../channels/email/thread";
import type { Connector } from "../connector/connector";
import { supplierEmailEn } from "../copy/en";
import type { MailOutcome } from "../domain/runtime";
import { type Operation, effectiveBehaviour } from "../domain/operations";
import type { BehaviourParams, Supplier } from "../domain/parties";
import { simNowOf } from "../lib/clock";
import { type FireDeps, type TimerAction, type TimerFiring, runTimer } from "../timers/fire";
import type { SchedulerPort } from "../timers/scheduler-client";
import type { TimerDeps, TimerDispatcher } from "../timers/timers";
import { NO_REPLY_REASONS, SIM_AUDIT_ACTIONS, SIM_REPLY_IDEMPOTENCY_SOURCE } from "./config";
import { type PlannedPdf, type Reaction, type ReplyPlan, type SimRequest, dailyCapReached, planImmediate, planReply, reactionTo } from "./behaviour";
import { type SendNowInvocation, type SimReplyResult, type SimReplyTimerInvocation, simReplyInvocation } from "./contract";
import type { VerifiedMail } from "./guard";
import { type ReplyDeps, type ReplyEnvelope, sendReply } from "./reply";
import { type AnsweredMail, type SimReplyPayload, claimReplyOnce, scheduleSimReply, simReplyTimerId } from "./timers";

export interface SimulatorDeps extends ReplyDeps {
  readonly data: Pick<Connector, "operations" | "parties" | "conversations" | "timers" | "runtime" | "audit" | "world">;
  /** The thread-address resolver of the email channel (HMAC tag, live operation, no tombstone). */
  readonly resolveThread: (address: string) => Promise<ThreadResolution>;
  /** The stage's single EventBridge Scheduler client (timers/scheduler-client.ts). */
  readonly scheduler: SchedulerPort;
}

export interface SupplierMailInput {
  readonly mail: VerifiedMail;
  readonly parsed: ParsedMail;
  readonly sesMessageId: string;
  /** The operation's world time when the mail arrived. */
  readonly simNow: string;
}

export interface SimulatorOutcome {
  readonly outcome: Extract<MailOutcome, "NO_REPLY" | "SIM_REPLY_SCHEDULED" | "SIM_REPLY_SENT">;
  readonly reason?: string;
}

const MAX_REFERENCES = 50;

const noReply = (reason: string): SimulatorOutcome => ({ outcome: "NO_REPLY", reason });

/**
 * The timers module as SimMail uses it. A `SIM_REPLY` that falls due 60 s or less from now in a RUNNING
 * world is dispatched right away: SimMail is its own consumer, so it runs here, in process.
 */
export function simTimerDeps(deps: SimulatorDeps): TimerDeps {
  const dispatcher: TimerDispatcher = {
    async dispatch(due) {
      if (due.timer.kind !== "SIM_REPLY") throw new ToolError("INVALID", `SimMail only dispatches SIM_REPLY timers, not ${due.timer.kind}`);
      const { timer } = due;
      await fireSimReply(deps, simReplyInvocation({ clockId: timer.clockId, operationId: timer.operationId, timerKey: `TIMER#SIM_REPLY#${timer.timerId}`, dueAtSim: timer.dueAtSim, version: timer.version, firedBy: due.firedBy, firmId: due.firmId, eventAtSim: due.eventAtSim }));
    },
  };
  return { data: deps.data, scheduler: deps.scheduler, dispatcher, realClock: deps.now, log: deps.log };
}

function addMs(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

/** The request of the verified outbound: `X-Legajo-Request` when it is about this operation, else what the message recorded. */
function requestOf(input: SupplierMailInput, operation: Operation): SimRequest {
  const operationNumber = parseOperationHeader(input.parsed.header(OPERATION_HEADER)[0]);
  const header = operationNumber === operation.operationNumber ? parseLegajoRequest(input.parsed.header(REQUEST_HEADER)[0]) : undefined;
  if (header !== undefined) return { kind: header.kind, docTypes: header.docTypes };
  return { kind: input.mail.outbound.kind ?? "REPLY", docTypes: input.mail.outbound.refs.docTypes ?? [] };
}

function answeredOf(input: SupplierMailInput): AnsweredMail {
  const { mail, parsed } = input;
  const references = [...parsed.references.filter((id) => id !== mail.rfcMessageId), mail.rfcMessageId].slice(-MAX_REFERENCES);
  return { messageId: mail.outbound.messageId, rfcMessageId: mail.rfcMessageId, references, subject: parsed.subject.slice(0, 998), threadAddress: mail.author, mailbox: mail.recipient };
}

function behaviourOf(operation: Operation, supplier: Supplier): { readonly behaviour: SupplierBehaviour; readonly params: BehaviourParams } {
  return { behaviour: effectiveBehaviour(operation, supplier.behaviour), params: operation.simBehaviourParams ?? supplier.behaviourParams };
}

function envelopeOf(operation: Operation, supplierName: string, answered: AnsweredMail, atSim: string, mode: ReplyEnvelope["mode"], extra: Partial<ReplyEnvelope> = {}): ReplyEnvelope {
  return {
    mode,
    operation,
    supplierName,
    mailbox: answered.mailbox,
    threadAddress: answered.threadAddress,
    purpose: { kind: "REPLY", answered: { from: answered.threadAddress, to: answered.mailbox } },
    subject: answered.subject,
    inReplyTo: answered.rfcMessageId,
    references: answered.references,
    atSim,
    ...extra,
  };
}

/** The live operation the reply would go to, or why there is none. */
async function liveOperation(deps: SimulatorDeps, input: SupplierMailInput): Promise<Operation | string> {
  if (parseThreadAddress(input.mail.author) === undefined) return NO_REPLY_REASONS.notThread;
  const resolution = await deps.resolveThread(input.mail.author);
  if (resolution.status !== "RESOLVED" || resolution.operation.operationId !== input.mail.outbound.operationId) return NO_REPLY_REASONS.worldGone;
  return resolution.operation;
}

/** What a supplier's mailbox does with a verified request; its effect is on record when this returns. */
export async function onSupplierMail(deps: SimulatorDeps, input: SupplierMailInput): Promise<SimulatorOutcome> {
  if (isAutoSubmitted(input.parsed.header(AUTO_SUBMITTED_HEADER))) return noReply(NO_REPLY_REASONS.autoSubmitted);
  const operation = await liveOperation(deps, input);
  if (typeof operation === "string") return noReply(operation);
  const supplier = await deps.data.parties.getSupplier(operation.supplierId);
  const { behaviour, params } = behaviourOf(operation, supplier);
  const request = requestOf(input, operation);
  const reaction: Reaction = reactionTo(behaviour, params, request);
  if (reaction.kind === "NO_REPLY") return noReply(reaction.reason);
  if (dailyCapReached(operation.simState, input.simNow, deps.now())) return noReply(NO_REPLY_REASONS.dailyCap);

  const answered = answeredOf(input);
  const timerDeps = simTimerDeps(deps);
  if (reaction.kind === "SCHEDULE") {
    await scheduleSimReply(timerDeps, { operation, timerId: simReplyTimerId(input.sesMessageId, "REPLY"), dueAtSim: addMs(input.simNow, reaction.afterMs), payload: { phase: "REPLY", behaviour, request: { kind: request.kind, docTypes: [...request.docTypes] }, answered } });
    return { outcome: "SIM_REPLY_SCHEDULED" };
  }
  await scheduleSimReply(timerDeps, { operation, timerId: simReplyTimerId(input.sesMessageId, "FOLLOW_UP"), dueAtSim: addMs(input.simNow, reaction.followUpAfterMs), payload: { phase: "FOLLOW_UP", behaviour, request: { kind: request.kind, docTypes: [...request.docTypes] }, answered } });
  // One immediate text per received mail, even if SES delivers the mail again.
  const first = await deps.data.runtime.claimIdempotency({ source: SIM_REPLY_IDEMPOTENCY_SOURCE, id: `immediate#${input.sesMessageId}`, atReal: deps.now().toISOString() });
  if (!first) return { outcome: "SIM_REPLY_SENT" };
  const plan = planImmediate(reaction.body, { request, state: operation.simState });
  const sent = await sendReply(deps, envelopeOf(operation, supplier.name, answered, input.simNow, "IMMEDIATE", { behaviour }), plan);
  return sent.status === "SENT" ? { outcome: "SIM_REPLY_SENT" } : { outcome: "SIM_REPLY_SCHEDULED", reason: sent.reason };
}

/** Highest seed version of each document of the operation's model. */
async function latestOf(deps: SimulatorDeps, operation: Operation): Promise<Record<DocType, number>> {
  const entries = await Promise.all(DocType.options.map(async (docType) => [docType, await deps.seed.latestVersion(operation.templateOperation, docType)] as const));
  return Object.fromEntries(entries) as Record<DocType, number>;
}

async function skipped(deps: SimulatorDeps, operation: Operation, timerKey: string, atSim: string, reason: string): Promise<SimReplyResult> {
  await deps.data.audit.record({
    firmId: operation.firmId,
    decision: "ACTION",
    action: SIM_AUDIT_ACTIONS.replySkipped,
    actor: "SYSTEM",
    reason,
    refs: { operationId: operation.operationId, timerKey },
    clockId: operation.clockId,
    operationId: operation.operationId,
    atSim,
    atReal: deps.now().toISOString(),
    correlationId: deps.log.correlationId,
  });
  return { status: "SKIPPED", reason };
}

/** The reply a claimed timer sends: the loop guard again, then its documents through the SIMULATOR profile. */
async function replyOfTimer(deps: SimulatorDeps, invocation: SimReplyTimerInvocation, payload: SimReplyPayload, dueAtSim: string): Promise<SimReplyResult> {
  const operation = await deps.data.operations.findOperation(invocation.operationId);
  if (operation === undefined) return { status: "SKIPPED", reason: NO_REPLY_REASONS.worldGone };
  if (dailyCapReached(operation.simState, dueAtSim, deps.now())) return skipped(deps, operation, invocation.timerKey, dueAtSim, NO_REPLY_REASONS.dailyCap);
  const supplier = await deps.data.parties.getSupplier(operation.supplierId);
  const plan: ReplyPlan = planReply({ behaviour: payload.behaviour, phase: payload.phase, request: payload.request, state: operation.simState, latest: await latestOf(deps, operation), unknownCount: deps.seed.unknownCount });
  const envelope = envelopeOf(operation, supplier.name, payload.answered, dueAtSim, "TIMER", { behaviour: payload.behaviour, timerKey: invocation.timerKey });
  const sent = await sendReply(deps, envelope, plan);
  if (sent.status === "REFUSED") return { status: "REFUSED", code: sent.code, reason: sent.reason };
  return { status: "SENT", mailId: sent.mailId ?? "", providerMessageId: sent.providerMessageId };
}

/**
 * A due `TIMER#SIM_REPLY#` (a hand-off of the timers module's dispatcher): the reply with its documents,
 * once. A SCHEDULED timer goes through `runTimer` (version check, `TIMER_FIRED`/`TIMER_SKIPPED` audited
 * once, `SCHEDULED → FIRED | SKIPPED`); a timer the clock already marked FIRED (docs/architecture.md §8,
 * "Avanzar el reloj") is answered by the firing that carries its `firedBy`. Either way the send itself
 * is claimed once (`claimReplyOnce`).
 */
export async function fireSimReply(deps: SimulatorDeps, invocation: SimReplyTimerInvocation): Promise<SimReplyResult> {
  const found = await deps.data.timers.findTimer(invocation.operationId, invocation.timerKey);
  if (found === undefined) return { status: "SKIPPED", reason: "TIMER_NOT_FOUND" };
  if (found.kind !== "SIM_REPLY" || found.clockId !== invocation.clockId) return { status: "SKIPPED", reason: "TIMER_MISMATCH" };
  const dueAtSim = found.dueAtSim;
  let result: SimReplyResult = { status: "SKIPPED", reason: "NOT_RUN" };
  const action: TimerAction = async ({ timer }) => {
    const claim = await claimReplyOnce(deps, timer);
    result = claim.ok ? await replyOfTimer(deps, invocation, claim.payload, dueAtSim) : { status: "SKIPPED", reason: claim.reason };
    if (result.status === "SENT") return { outcome: "FIRED", detail: { mailId: result.mailId } };
    return { outcome: "SKIPPED", reason: result.status === "SKIPPED" ? result.reason : result.code };
  };

  if (found.status === "FIRED") {
    if (invocation.firedBy === "SCHEDULER" || found.firedBy !== invocation.firedBy) return { status: "SKIPPED", reason: "ALREADY_SENT" };
    await action({ timer: found, firing: await firingOf(deps, invocation, dueAtSim) });
    return result;
  }
  if (found.status !== "SCHEDULED") return { status: "SKIPPED", reason: `TIMER_${found.status}` };
  const fireDeps: FireDeps = { data: deps.data, scheduler: deps.scheduler, realClock: deps.now, log: deps.log };
  const outcome = await runTimer(await firingOf(deps, invocation, dueAtSim), action, fireDeps);
  if (outcome.outcome === "MISSING") return { status: "SKIPPED", reason: "TIMER_NOT_FOUND" };
  if (outcome.outcome === "STALE") return { status: "SKIPPED", reason: "STALE_SCHEDULE" };
  if (outcome.outcome === "DONE") return { status: "SKIPPED", reason: outcome.timer.status === "FIRED" ? "ALREADY_SENT" : `TIMER_${outcome.timer.status}` };
  return result;
}

async function firingOf(deps: SimulatorDeps, invocation: SimReplyTimerInvocation, dueAtSim: string): Promise<TimerFiring> {
  const firmId = invocation.firmId ?? (await deps.data.world.getClock(invocation.clockId)).firmId;
  return { operationId: invocation.operationId, clockId: invocation.clockId, firmId, timerKey: invocation.timerKey, version: invocation.version, dueAtSim, eventAtSim: invocation.eventAtSim ?? dueAtSim, firedBy: invocation.firedBy, correlationId: deps.log.correlationId };
}

/** The email the `QaDriver`'s `supplier.sendNow` asks for: QA worlds only, from the ACTIVE contact to the thread address. */
export async function sendNow(deps: SimulatorDeps, invocation: SendNowInvocation): Promise<SimReplyResult> {
  if (parseClockId(invocation.clockId)?.scope !== "QA") return { status: "REFUSED", code: "FORBIDDEN", reason: "SEND_NOW only in QA worlds" };
  const operation = await deps.data.operations.findOperation(invocation.operationId);
  if (operation === undefined || operation.clockId !== invocation.clockId) return { status: "REFUSED", code: "NOT_FOUND", reason: "no such operation in this world" };
  const supplier = await deps.data.parties.getSupplier(operation.supplierId);
  const contact = (await deps.data.parties.listContacts(operation.supplierId)).filter((candidate) => candidate.status === "ACTIVE").sort((a, b) => a.contactId.localeCompare(b.contactId))[0];
  if (contact === undefined) return { status: "REFUSED", code: "INVALID", reason: "the operation's supplier has no ACTIVE contact" };

  const thread = (await deps.data.conversations.listMessages(operation.operationId, { channel: "EMAIL" })).filter((message) => message.counterpart === "SUPPLIER" && message.rfcMessageId !== undefined);
  const last = thread[thread.length - 1];
  const subject = last?.subject ?? supplierEmailEn.subject("REPLY", { operationNumber: operation.operationNumber, invoiceNumber: operation.invoiceNumber, docTypes: invocation.docTypes });
  const references = last === undefined || last.rfcMessageId === undefined ? [] : [...last.references, last.rfcMessageId];
  const docTypes = DocType.options.filter((docType) => invocation.docTypes.includes(docType));
  const plan: ReplyPlan = { body: { kind: "DOCUMENTS" }, pdfs: docTypes.map((docType): PlannedPdf => ({ source: "TEMPLATE", docType, version: invocation.version })), claimed: docTypes, autoReply: false, versions: {}, injectionStep: operation.simState.injectionStep };
  const simNow = simNowOf(await deps.data.world.getClock(operation.clockId), deps.now().getTime()).toISOString();
  const envelope: ReplyEnvelope = {
    mode: "SEND_NOW",
    operation,
    supplierName: supplier.name,
    mailbox: contact.email,
    threadAddress: operation.threadAddress,
    purpose: { kind: "SEND_NOW", operationId: operation.operationId },
    subject,
    ...(last?.rfcMessageId === undefined ? {} : { inReplyTo: last.rfcMessageId }),
    references,
    atSim: simNow,
    mailId: invocation.mailId,
    ...(invocation.body === undefined ? {} : { body: invocation.body }),
  };
  try {
    const sent = await sendReply(deps, envelope, plan);
    if (sent.status === "REFUSED") return { status: "REFUSED", code: sent.code, reason: sent.reason };
    return { status: "SENT", mailId: sent.mailId ?? invocation.mailId, providerMessageId: sent.providerMessageId };
  } catch (error) {
    if (error instanceof ToolError && error.code === "NOT_FOUND") return { status: "REFUSED", code: "NOT_FOUND", reason: error.message };
    if (error instanceof ConnectorError && error.code === "NOT_FOUND") return { status: "REFUSED", code: "NOT_FOUND", reason: "the operation's supplier is gone" };
    throw error;
  }
}
