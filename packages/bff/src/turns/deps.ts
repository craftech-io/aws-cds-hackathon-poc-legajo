// What a turn needs and what it ends in. The Lambda entry builds the real dependencies
// (handlers/operation-worker.ts); the tests and the local flows build them over the in-memory connector,
// a scripted Harness and a scripted G1.
import type { AgentMode, GuardrailOrigin } from "@legajo/shared";
import type { HarnessClient } from "../agent/harness-client";
import type { Connector } from "../connector/index";
import type { TokenUsage } from "../domain/conversations";
import type { SecretKey } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { EscalationPort, EventHandlers, TurnFailureCause } from "../worker/ports";
import type { G1Prefilter } from "./prefilter";
import type { TurnReads } from "./preload";

export interface TurnDeps {
  readonly data: Connector;
  readonly harness: HarnessClient;
  readonly prefilter: G1Prefilter;
  readonly escalation: EscalationPort;
  /** Only the fallback of a failed first request is a handler of another module during a turn. */
  readonly handlers: Pick<EventHandlers, "milestoneFallback">;
  /** `consumeQuota(clockId, "AGENT_TURNS")` of worlds/guest-quotas.ts, logging its metrics on `log`. */
  readonly consumeTurnQuota: (clockId: string, log: Logger) => Promise<void>;
  /** HKDF `session` subkey (tokens of the turn). */
  readonly sessionKey: () => SecretKey;
  /** HKDF `runtime-session` subkey (`runtimeSessionId`). */
  readonly runtimeSessionKey: () => SecretKey;
  /** `REAL` in the stage, `SCRIPTED` in the local flows (`LegajoMetrics.agentMode`). */
  readonly agentMode: AgentMode;
  /** The operations target in process: the reads the worker runs before the Harness (turns/preload.ts). */
  readonly reads?: TurnReads;
  /** Injected for tests: turn delimiters and ids. */
  readonly random?: (size: number) => Uint8Array;
}

export type SkipReason = "NO_OPERATION" | "CONTROL_BROKER" | "TURN_QUOTA" | "TURN_CAP";

export type TurnOutcome =
  | { readonly kind: "SKIPPED"; readonly reason: SkipReason }
  | { readonly kind: "BLOCKED"; readonly origin: GuardrailOrigin; readonly escalationId: string; readonly turnId?: string }
  | { readonly kind: "COMPLETED"; readonly turnId: string; readonly usage: TokenUsage; readonly stopReason: string; readonly toolUses: number }
  | { readonly kind: "FAILED"; readonly turnId: string; readonly cause: TurnFailureCause };
