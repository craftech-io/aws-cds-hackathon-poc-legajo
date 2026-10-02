// The console refusals that leave a trace in the firm's audit log (docs/architecture.md §10,
// FL-075, FL-082): an id of another firm (`DENY CROSS_FIRM`), an input the firm fence cannot check
// whole (`DENY INPUT_TOO_LARGE`) and a role that may not run the procedure (`DENY ROLE_NOT_ALLOWED`). The decision is written in the partition of the principal's
// own firm and never on the other firm's operation index: the attempted id travels only in
// `detail`, so the other firm's timeline shows nothing of who asked.
import type { DecisionInput } from "../connector/ports-runtime";
import { brokerActor } from "../domain/common";
import type { Principal } from "./principal";
import type { FencedId } from "./scope";

export type AuditedRefusal = "CROSS_FIRM" | "INPUT_TOO_LARGE" | "ROLE_NOT_ALLOWED";

export interface DenialInput {
  readonly principal: Principal;
  readonly refusal: AuditedRefusal;
  /** tRPC path of the procedure (`dossier.approve`). */
  readonly path: string;
  readonly correlationId: string;
  /** Real time of the refusal: it happens in the console, outside any world. */
  readonly at: Date;
  readonly message: string;
  readonly target?: FencedId;
}

export function denialDecision(input: DenialInput): DecisionInput {
  const { principal } = input;
  return {
    firmId: principal.firmId,
    decision: "DENY",
    action: input.refusal,
    actor: principal.brokerId === undefined ? "SYSTEM" : brokerActor(principal.brokerId),
    refs: principal.brokerId === undefined ? {} : { brokerId: principal.brokerId },
    reason: input.message,
    atReal: input.at.toISOString(),
    correlationId: input.correlationId,
    detail: {
      procedure: input.path,
      role: principal.role,
      // A principal the directory has not matched yet (a guest before its world exists) is named by its sub.
      ...(principal.brokerId === undefined ? { sub: principal.sub } : {}),
      ...(input.target === undefined ? {} : { targetKind: input.target.kind, targetId: input.target.id }),
    },
  };
}
