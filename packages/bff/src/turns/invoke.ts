// One invocation of the Harness for a turn that passed every gate (docs/architecture.md §9.1): the
// session and the open turn, a random delimiter named by that turn's system prompt, the envelope, the
// actor and session of the operation, and what the stream left (note, usage, stop). The turn is closed
// whatever happens, so its token dies with it.
//
//   end_turn / stop_sequence                     note and usage; first-response latency of a party's message
//   content_filtered / guardrail_intervened      the sentinel never leaves: worker/guardrail-block.ts
//   any other stop, a timeout, a stream error    `TURN_FAILED` and `TurnErrors`; a `MILESTONE DOCS_REQUEST`
//                                                turn gets its deterministic fallback (FL-097)
//   a throttled call that ran out of retries     the turn closes and the event goes back to the queue
import { buildSystemPrompt } from "../agent/system-prompt";
import { renderEnvelope } from "../agent/envelope";
import { type HarnessTurnResult, HarnessError } from "../agent/harness-client";
import { newTurnDelimiter } from "../channels/normalizer";
import type { Operation } from "../domain/operations";
import { WORKER_ACTIONS, auditOnce } from "../worker/audit";
import type { TurnEvent } from "../worker/events";
import { handleGuardrailBlock } from "../worker/guardrail-block";
import type { TurnFailureCause, WorkerContext } from "../worker/ports";
import type { TurnDeps, TurnOutcome } from "./deps";
import { type TurnInbound, envelopeAttachments, envelopeEvent, envelopeFacts } from "./envelope";
import { takeForcedFailure } from "./forced-failure";
import { harnessIdentity } from "./identity";
import { followRoute } from "./routed";
import { FIXED_NOTES, type TurnRecordDeps, logTurnError, logTurnLatency, recordFirstResponse, recordUsage, writeTurnNote } from "./record";
import { type OpenedTurn, closeTurnSession, openTurnSession } from "./session";

export interface InvokeInput {
  readonly operation: Operation;
  readonly event: TurnEvent;
  readonly inbound?: TurnInbound;
}

type Invocation = { readonly ran: true; readonly result: HarnessTurnResult; readonly latencyMs: number } | { readonly ran: false; readonly cause: TurnFailureCause };

function recordDeps(deps: TurnDeps, ctx: WorkerContext): TurnRecordDeps {
  return { data: deps.data, agentMode: deps.agentMode, now: ctx.now, log: ctx.log };
}

async function envelopeOf(deps: TurnDeps, input: InvokeInput, session: OpenedTurn, delimiter: string): Promise<string> {
  const { operation, event, inbound } = input;
  const [facts, attachments] = await Promise.all([envelopeFacts(deps.data, operation, event), envelopeAttachments(deps.data, operation, event, inbound)]);
  return renderEnvelope({
    sessionToken: session.token,
    event: envelopeEvent(event, operation),
    facts,
    ...(inbound === undefined ? {} : { inbound: { delimiter, text: inbound.text, channel: inbound.channel, fromRole: inbound.fromRole, trusted: inbound.trusted, truncated: inbound.truncated } }),
    attachments,
  });
}

async function invokeHarness(deps: TurnDeps, ctx: WorkerContext & { readonly deadlineMs: number }, input: InvokeInput, session: OpenedTurn): Promise<Invocation> {
  const delimiter = newTurnDelimiter(deps.random);
  const envelope = await envelopeOf(deps, input, session, delimiter);
  const forced = await takeForcedFailure(deps.data.runtime, { operationId: input.operation.operationId, clockId: input.operation.clockId, turnId: session.turnId, atReal: ctx.now().toISOString() });
  if (forced) return { ran: false, cause: "TIMEOUT" };
  const identity = harnessIdentity(deps.runtimeSessionKey(), input.operation, input.event.trigger);
  const started = ctx.now().getTime();
  try {
    const result = await deps.harness.invoke({ ...identity, envelope, systemPrompt: buildSystemPrompt({ delimiter }), deadlineMs: ctx.deadlineMs });
    return { ran: true, result, latencyMs: ctx.now().getTime() - started };
  } catch (error) {
    if (!(error instanceof HarnessError) || error.kind === "THROTTLED") throw error;
    // AWS's error name and message (no payload): what to fix, without guessing.
    const cause = error.cause instanceof Error ? { causeName: error.cause.name, causeMessage: error.cause.message.slice(0, 300) } : {};
    ctx.log.warn("turn.harness_failed", { kind: error.kind, turnId: session.turnId, ...cause });
    return { ran: false, cause: error.kind === "TIMEOUT" ? "TIMEOUT" : "HARNESS_ERROR" };
  }
}

async function failTurn(deps: TurnDeps, ctx: WorkerContext, input: InvokeInput, turnId: string, cause: TurnFailureCause, stopReason?: string, note?: string): Promise<TurnOutcome> {
  const { operation, event } = input;
  await writeTurnNote(recordDeps(deps, ctx), { operation, event, turnId, text: note === undefined || note === "" ? FIXED_NOTES.failed : note, ...(stopReason === undefined ? {} : { stopReason }) });
  await auditOnce(deps.data.audit, {
    action: WORKER_ACTIONS.turnFailed,
    eventId: event.eventId,
    firmId: operation.firmId,
    clockId: operation.clockId,
    operationId: operation.operationId,
    atSim: event.eventAtSim,
    atReal: ctx.now().toISOString(),
    trigger: event.trigger,
    refs: { turnId },
    detail: { cause, ...(stopReason === undefined ? {} : { stopReason }) },
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
  });
  logTurnError(ctx.log, { cause, trigger: event.trigger });
  await fallbackIfFirstRequest(deps, ctx, event, turnId, cause);
  return { kind: "FAILED", turnId, cause };
}

/** FL-097: a `MILESTONE DOCS_REQUEST` turn that failed hands over to the deterministic first request. */
async function fallbackIfFirstRequest(deps: TurnDeps, ctx: WorkerContext, event: TurnEvent, turnId: string, cause: TurnFailureCause): Promise<void> {
  if (event.trigger !== "MILESTONE" || event.milestone !== "DOCS_REQUEST") return;
  await deps.handlers.milestoneFallback({ event, turnId, cause }, ctx);
}

async function finishTurn(deps: TurnDeps, ctx: WorkerContext, input: InvokeInput, turnId: string, result: HarnessTurnResult): Promise<TurnOutcome> {
  const { operation, event, inbound } = input;
  const record = recordDeps(deps, ctx);
  await recordUsage(record, operation, result.usage);
  if (result.outcome === "INCOMPLETE") return failTurn(deps, ctx, input, turnId, "INCOMPLETE", result.stopReason, result.note);
  if (result.outcome === "GUARDRAIL") {
    await writeTurnNote(record, { operation, event, turnId, text: FIXED_NOTES.guardrail, usage: result.usage, stopReason: result.stopReason });
    const source = inbound === undefined || inbound.source === "SYSTEM" ? "SYSTEM" : inbound.source;
    const blocked = await handleGuardrailBlock(
      { data: deps.data, escalation: deps.escalation, sink: ctx.sink, log: ctx.log, now: ctx.now },
      { event, operation, block: { origin: "HARNESS", source, policy: "HARNESS", stopReason: result.stopReason }, turnId, ...(inbound?.message === undefined ? {} : { message: inbound.message }) },
    );
    await fallbackIfFirstRequest(deps, ctx, event, turnId, "GUARDRAIL");
    return { kind: "BLOCKED", origin: "HARNESS", escalationId: blocked.escalationId, turnId };
  }
  await writeTurnNote(record, { operation, event, turnId, text: result.note, usage: result.usage, stopReason: result.stopReason });
  if (inbound?.message !== undefined && inbound.source !== "SYSTEM") await recordFirstResponse(record, operation, turnId, inbound.message);
  return { kind: "COMPLETED", turnId, usage: result.usage, stopReason: result.stopReason, toolUses: result.toolUses };
}

/** Runs the turn and closes it; a throttled Harness closes it and puts the event back on the queue. */
export async function invokeTurn(deps: TurnDeps, ctx: WorkerContext & { readonly deadlineMs: number }, input: InvokeInput): Promise<TurnOutcome> {
  const sessionDeps = { runtime: deps.data.runtime, sessionKey: deps.sessionKey(), now: ctx.now, ...(deps.random === undefined ? {} : { random: deps.random }) };
  const session = await openTurnSession(sessionDeps, input.operation, input.event);
  let invocation: Invocation;
  try {
    invocation = await invokeHarness(deps, ctx, input, session);
  } finally {
    await closeTurnSession(sessionDeps, session.turnId);
  }
  if (!invocation.ran) return failTurn(deps, ctx, input, session.turnId, invocation.cause);
  logTurnLatency(ctx.log, invocation.latencyMs, { trigger: input.event.trigger, outcome: invocation.result.outcome, toolUses: invocation.result.toolUses });
  const outcome = await finishTurn(deps, ctx, input, session.turnId, invocation.result);
  if (outcome.kind === "COMPLETED") await followRoute(deps.data, ctx, { operation: input.operation, event: input.event, turnId: session.turnId });
  return outcome;
}
