// The session of one turn (docs/architecture.md §9.1, docs/tool-catalog.md "Sesión"): before the
// Harness is invoked the worker writes `Runtime/SESSION#<sessionId>` with the identity of the operation
// and `Runtime/TURN#<turnId>`, and signs `sessionToken = <sessionId>.<turnId>.<exp>.<HMAC>` with the
// `session` subkey, valid for at most 15 real minutes. Every Gateway tool derives operation, firm,
// importer, supplier, clock and trigger from that row (services/session.ts `resolveSession`), never
// from the model. When the turn ends the worker closes it (`closedAtReal`), so a token copied out of
// a turn is refused by the tools even before it expires.
import { SESSION_TOKEN_MAX_TTL_SECONDS } from "@legajo/shared";
import type { RuntimePort } from "../connector/index";
import type { Operation } from "../domain/operations";
import { type SecretKey, ulid } from "../lib/crypto";
import { issueSessionToken } from "../services/session";
import type { TurnEvent } from "../worker/events";

export interface OpenedTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly token: string;
  /** Epoch seconds the token stops being valid. */
  readonly exp: number;
}

export interface TurnSessionDeps {
  readonly runtime: Pick<RuntimePort, "putSession" | "openTurn" | "closeTurn">;
  /** HKDF `session` subkey. */
  readonly sessionKey: SecretKey;
  /** Real time: ids order writes, tokens live in real time. */
  readonly now: () => Date;
  /** Injected for tests; 10 random bytes per id. */
  readonly random?: (size: number) => Uint8Array;
}

/** Writes the session and the open turn, then signs the token (≤ 15 minutes, never more than the turn may last). */
export async function openTurnSession(deps: TurnSessionDeps, operation: Operation, event: TurnEvent, ttlSeconds: number = SESSION_TOKEN_MAX_TTL_SECONDS): Promise<OpenedTurn> {
  const nowMs = deps.now().getTime();
  const sessionId = deps.random === undefined ? ulid(nowMs) : ulid(nowMs, deps.random);
  const turnId = deps.random === undefined ? ulid(nowMs) : ulid(nowMs, deps.random);
  const openedAtReal = new Date(nowMs).toISOString();
  await deps.runtime.putSession({
    sessionId,
    turnId,
    operationId: operation.operationId,
    firmId: operation.firmId,
    importerId: operation.importerId,
    supplierId: operation.supplierId,
    trigger: event.trigger,
    clockId: operation.clockId,
    eventAtSim: event.eventAtSim,
    eventId: event.eventId,
    worldEpoch: operation.worldEpoch,
    sessionEpoch: operation.sessionEpoch,
  });
  await deps.runtime.openTurn({ turnId, sessionId, operationId: operation.operationId, clockId: operation.clockId, trigger: event.trigger, openedAtReal });
  const { token, exp } = issueSessionToken(deps.sessionKey, { sessionId, turnId, ttlSeconds: Math.min(ttlSeconds, SESSION_TOKEN_MAX_TTL_SECONDS) }, nowMs);
  return { sessionId, turnId, token, exp };
}

/** Closes the turn: from here on every tool refuses its token (`TURN_CLOSED`). */
export async function closeTurnSession(deps: Pick<TurnSessionDeps, "runtime" | "now">, turnId: string): Promise<void> {
  await deps.runtime.closeTurn(turnId, deps.now().toISOString());
}
