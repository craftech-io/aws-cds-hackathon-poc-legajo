// What the direct handlers need besides the connector (docs/tool-catalog.md, "Handlers de invocación
// directa"). Two groups:
//
//   Wired by the Lambda entry that hosts the handlers (`ServicePorts`):
//     events      producer of `OperationEvents.fifo` (worker/sink.ts): `ADD` to the operation's and the
//                 world's `inFlight`, then `SendMessage` with `MessageGroupId = operationId`
//     timers      the `TIMER#` lifecycle with its real schedule in a RUNNING world, and the dispatcher
//                 of a milestone already due (timers/timers.ts, milestones/schedule.ts)
//     approvals   `request_approval` as the worker, when a firm decision leaves the dossier complete
//                 (agent-tools/handoff, in process)
//     deferred    the pipeline's new decision on a deferred message (outbound/)
//
//   What the stage gives (`stageServiceDeps`): the keyed hashes and the thread key (lib/secrets.ts), the
//   demo recipients of `SeedOverrides`, the `Runtime` table the guest-world quotas count in
//   (worlds/guest-quotas.ts) and the customs platform (`PlatformMock`, platform.ts).
import { connector as stageConnector, tableClient } from "../../connector/index";
import type { TableClient } from "../../connector/table-client";
import { emailHash, phoneHash, ulid } from "../../lib/crypto";
import { createLogger } from "../../lib/log";
import { seedOverrides, subkey } from "../../lib/secrets";
import type { MilestoneDeps } from "../../milestones/schedule";
import type { OperationEventSink } from "../../worker/sink";
import type { KitDeps } from "./handler-kit";
import { type PlatformOperations, linkedPlatformClient } from "./platform";

export interface ApprovalRequests {
  /** `request_approval` with principal `worker`: `READY_FOR_REVIEW` and the "ready for review" email. */
  requestApproval(input: { readonly operationId: string; readonly firmId: string; readonly clockId: string; readonly atSim: string; readonly eventId: string }): Promise<void>;
}

export type DeferredOutcome = "SENT" | "DEFERRED" | "DENIED";

export interface DeferredSender {
  /**
   * The pipeline decides the stored `DEFERRED` message again at `atSim` (steps 1-3 and 7) and sends it,
   * defers it again (a new `TIMER#DEFERRED_SEND#`, `nextAllowedAt`) or denies it.
   */
  resend(input: { readonly operationId: string; readonly messageId: string; readonly timerKey: string; readonly atSim: string; readonly correlationId?: string }): Promise<{ readonly status: DeferredOutcome; readonly nextAllowedAt?: string }>;
}

export interface PartyKeys {
  /** `phoneHash` of `Parties GSI1` and `ADDR#` (subkey `phone-hash`). */
  phoneHash(phone: string): string;
  /** `emailHash` of `Parties GSI2` and `ADDR#` (subkey `email-hash`). */
  emailHash(email: string): string;
  /** Subkey `thread`: the HMAC of every operation's thread tag. */
  threadKey(): Uint8Array;
}

export interface ServicePorts {
  readonly events: OperationEventSink;
  /** `armTimer`, `closeTimer`, `closeOperationTimers` and `scheduleMilestones` run over these. */
  readonly timers: MilestoneDeps;
  readonly approvals: ApprovalRequests;
  readonly deferred: DeferredSender;
}

export interface ServiceDeps extends KitDeps, ServicePorts {
  readonly keys: PartyKeys;
  /** `SeedOverrides.demoRecipients.emails`: real inboxes, PII, never logged. */
  readonly demoRecipients: () => readonly string[];
  /** `Runtime`, where the guest-world quotas count (`QUOTA#<clockId>#<kind>#<window>`). */
  readonly quotaTable: TableClient;
  readonly platform: PlatformOperations;
  /** New ids of the parties the console registers (`imp-<id>`, `sup-<id>`, `ctc-<id>`). */
  readonly newId: () => string;
}

/** The dependencies of a Lambda: the stage's connector, keys and platform plus the ports its entry wires. */
export function stageServiceDeps(ports: ServicePorts, options: { readonly platform?: PlatformOperations } = {}): ServiceDeps {
  const wallClock = () => new Date();
  return {
    ...ports,
    connector: stageConnector(),
    wallClock,
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "services" } }),
    keys: {
      phoneHash: (phone) => phoneHash(subkey("phone-hash"), phone),
      emailHash: (email) => emailHash(subkey("email-hash"), email),
      threadKey: () => subkey("thread"),
    },
    demoRecipients: () => seedOverrides().demoRecipients.emails,
    quotaTable: tableClient(),
    platform: options.platform ?? linkedPlatformClient(),
    newId: () => ulid(wallClock().getTime()),
  };
}
