// The `QaDriver` (ADR-0005, docs/test-plan.md §4): one Lambda with a closed set of actions, invoked
// only by the bootstrap's `qa-runner` role. Every request goes through the same steps:
//
//   1. envelope and input parsed with zod (`.strict()`: an unknown key is INVALID);
//   2. the world resolved from stored data and fenced (guard.ts): QA firms, `qa-*` clocks and the two
//      closed lists; anything else is FORBIDDEN before a byte is written;
//   3. a changing action already done under the same idempotency key answers its first result
//      (`replayed: true`); provider ids derive from the key, so even a lost answer retried twice
//      produces one effect;
//   4. the action runs; its failure comes back as `{ ok: false, error }`, never as a thrown error.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ToolError, toToolFailure } from "@legajo/shared";
import type { Connector } from "../connector/index";
import type { Logger } from "../lib/log";
import { consoleFailure, procedureKind } from "./console";
import { QaRequest, type QaResponse, READ_ONLY_ACTIONS, type QaActionName } from "./contract";
import { ACTION_INPUTS, type QaParsedInput } from "./contract-inputs";
import { checkFence, checkWorldKey, resolveScope } from "./guard";
import type { ActionContext, ActionHandlers } from "./ports";

/** Source of the driver's idempotency marks (`Runtime/IDEMP#QA#<key>`). */
export const QA_IDEMPOTENCY_SOURCE = "QA";

/** A result larger than this is not kept for replay: the action runs again (its effects are idempotent by key). */
export const MAX_REPLAY_BYTES = 64 * 1024;

export interface QaDriverDeps {
  readonly data: Connector;
  readonly handlers: ActionHandlers;
  /** Real time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly loggerFor: (correlationId: string) => Logger;
}

/** Whether the action changes something (and so is remembered under its key). */
function changes(action: QaActionName, input: unknown): boolean {
  if (action === "console") return procedureKind((input as { procedure: string }).procedure) === "mutation";
  return !READ_ONLY_ACTIONS.has(action);
}

function failureOf(error: unknown): QaResponse {
  if (error instanceof TRPCError) return { ok: false, error: consoleFailure(error).toFailure().error };
  if (error instanceof z.ZodError) {
    const where = error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ");
    return { ok: false, error: { code: "INVALID", message: `invalid input: ${where}`, reason: "VALIDATION" } };
  }
  return { ok: false, error: toToolFailure(error).error };
}

type Replay = { readonly found: false } | { readonly found: true; readonly result: unknown };

async function replayOf(data: Connector, key: string): Promise<Replay> {
  const mark = await data.runtime.getIdempotency(QA_IDEMPOTENCY_SOURCE, key);
  const stored = mark?.result;
  if (stored === undefined || stored.oversize === true) return { found: false };
  return { found: true, result: stored.value ?? null };
}

async function remember(data: Connector, key: string, result: unknown, atReal: string): Promise<void> {
  const json = JSON.stringify(result ?? null);
  const stored = json.length > MAX_REPLAY_BYTES ? { oversize: true } : { value: JSON.parse(json) as unknown };
  // A concurrent twin of this call may have written first: its effect is the same one (ids derive from the key).
  await data.runtime.claimIdempotency({ source: QA_IDEMPOTENCY_SOURCE, id: key, atReal, result: stored });
}

export function createQaDriver(deps: QaDriverDeps) {
  const lookups = {
    async findOperation(operationId: string) {
      const operation = await deps.data.operations.findOperation(operationId);
      return operation === undefined ? undefined : { operationId: operation.operationId, firmId: operation.firmId, clockId: operation.clockId };
    },
  };

  return async function run(raw: unknown): Promise<QaResponse> {
    const started = deps.now().getTime();
    const envelope = QaRequest.safeParse(raw);
    if (!envelope.success) return failureOf(envelope.error);
    const { action, idempotencyKey } = envelope.data;
    const log = deps.loggerFor(idempotencyKey.replaceAll("/", "-")).child({ service: "qa-driver", action });
    try {
      const input: unknown = ACTION_INPUTS[action].parse(envelope.data.input ?? {});
      if (action === "world.create") checkWorldKey(idempotencyKey, input as QaParsedInput<"world.create">);
      const scope = await resolveScope(action, input, lookups);
      checkFence(scope);
      const mutating = changes(action, input);
      if (mutating) {
        const replay = await replayOf(deps.data, idempotencyKey);
        if (replay.found) {
          log.info("qa_driver.replayed", { clockId: scope.clockId ?? null });
          return { ok: true, replayed: true, result: replay.result };
        }
      }
      const ctx: ActionContext = { idempotencyKey, scope, data: deps.data, now: deps.now, sleep: deps.sleep, log };
      const handler = deps.handlers[action] as (parsed: unknown, context: ActionContext) => Promise<unknown>;
      const result = await handler(input, ctx);
      if (mutating) await remember(deps.data, idempotencyKey, result, deps.now().toISOString());
      log.info("qa_driver.done", { clockId: scope.clockId ?? null, ms: deps.now().getTime() - started });
      return { ok: true, replayed: false, result };
    } catch (error) {
      const failure = failureOf(error);
      const fields = { code: failure.ok ? null : failure.error.code, reason: failure.ok ? null : (failure.error.reason ?? null), ms: deps.now().getTime() - started };
      if (error instanceof ToolError || error instanceof z.ZodError || error instanceof TRPCError) log.warn("qa_driver.refused", fields);
      else log.error("qa_driver.failed", { ...fields, errorName: error instanceof Error ? error.name : "unknown" });
      return failure;
    }
  };
}

export type QaDriver = ReturnType<typeof createQaDriver>;
