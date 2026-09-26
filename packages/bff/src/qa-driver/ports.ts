// What the `QaDriver` drives but does not own (docs/build-plan.md WP-37): the world factory (WP-31),
// the clock (WP-27), the channel entries and the single SES client (WP-19, WP-20, WP-29), the supplier
// simulator (WP-30), the worker (WP-28), the recipient fence and contact policy (WP-17, WP-25) and the
// metrics batch (WP-39). Each is a port: the Lambda entry wires the module that owns it, and until that
// module exists the action answers `UNAVAILABLE` with reason `NOT_WIRED` instead of taking a shortcut
// around policy, Cedar or the outbound pipeline.
import { ToolError, type DocType, type WaButtonAction } from "@legajo/shared";
import type { Connector } from "../connector/index";
import type { Logger } from "../lib/log";
import { QA_REASON, type QaActionName } from "./contract";
import type { QaParsedInput } from "./contract-inputs";
import type { Scope } from "./guard";

/** What every action handler receives besides its input. */
export interface ActionContext {
  readonly idempotencyKey: string;
  readonly scope: Scope;
  readonly data: Connector;
  /** Real time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: Logger;
}

export type ActionHandler<A extends QaActionName> = (input: QaParsedInput<A>, ctx: ActionContext) => Promise<unknown>;
export type ActionHandlers = { readonly [A in QaActionName]: ActionHandler<A> };

export interface WorldOperationCreated {
  readonly key: string;
  readonly operationId: string;
  readonly operationNumber: string;
  readonly importerId: string;
  readonly supplierId: string;
  readonly threadAddress: string;
  /** The supplier's contacts as created: the main one first, then the alternatives `altContacts` mapped. */
  readonly contacts: ReadonlyArray<{ readonly contactId: string; readonly email: string; readonly status: string }>;
}

/** Answer of `world.create` (the same when it already existed: `created: false`). */
export interface WorldCreated {
  readonly clockId: string;
  readonly firmId: string;
  readonly worldEpoch: number;
  readonly created: boolean;
  readonly operations: readonly WorldOperationCreated[];
  readonly firmMailbox: string;
}

export interface WorldFactoryPort {
  create(input: QaParsedInput<"world.create">, ctx: ActionContext): Promise<WorldCreated>;
  /** Conditional deletes (`world = qa`), schedules, S3 under `qa/<runId>/`, Memory purge, tombstone. */
  destroy(clockId: string, ctx: ActionContext): Promise<{ readonly destroyed: boolean; readonly worldEpoch?: number }>;
}

export interface ClockMoved {
  readonly simNow: string;
  readonly fired: ReadonlyArray<{ readonly operationId: string; readonly timerKey: string; readonly dueAtSim: string }>;
}

export type ClockTarget = { readonly byMinutes: number } | { readonly to: string } | { readonly next: true };

export interface ClockPort {
  /** Moves a paused world and dispatches what fell due, in `dueAtSim` order (no `WORLD_BUSY` gate). */
  advance(clockId: string, target: ClockTarget, ctx: ActionContext): Promise<ClockMoved>;
  fireMilestone(operationId: string, milestone: QaParsedInput<"clock.fireMilestone">["milestone"], ctx: ActionContext): Promise<ClockMoved>;
  /** Atomic: paused at `next due − leadSec`, then RUNNING with the schedules of the horizon. */
  unfreeze(clockId: string, leadSec: number, ctx: ActionContext): Promise<{ readonly timerKey: string; readonly dueAtSim: string; readonly dueAtReal: string }>;
  freeze(clockId: string, ctx: ActionContext): Promise<{ readonly simNow: string }>;
}

/** An inbound WhatsApp as the simulated path receives it; ids resolved by the driver, never by the scenario. */
export type WhatsAppInbound =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "button"; readonly action: WaButtonAction; readonly nonce: string }
  | { readonly type: "document"; readonly docType: DocType; readonly version: number; readonly templateOperation: string }
  | { readonly type: "media"; readonly mediaType: "image" | "audio" | "video" | "sticker" }
  | { readonly type: "choice"; readonly nonce: string };

export interface EmailInjection {
  readonly clockId: string;
  /** `qainject-<runId>-<scenario>@sim…`, or the registered address of a party of this world. */
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly autoReply: boolean;
  readonly attachments: ReadonlyArray<{ readonly docType: DocType; readonly version: number; readonly templateOperation: string }>;
  readonly mailId: string;
  readonly messageIdHeader: string;
  readonly operationId?: string;
}

export interface ChannelsPort {
  /** Same entry as the phone simulator: the SNS envelope `InboundWhatsApp` verifies. */
  whatsappInbound(input: { readonly operationId: string; readonly clockId: string; readonly from: "IMPORTER" | "UNREGISTERED"; readonly wamid: string; readonly message: WhatsAppInbound }, ctx: ActionContext): Promise<{ readonly messageId?: string }>;
  /** The single SES client with profile `QA` (it checks the `From` against the registry). */
  injectEmail(input: EmailInjection, ctx: ActionContext): Promise<{ readonly sesMessageId: string }>;
  /** `InboundEmail` again with the same receipt and the same S3 object. */
  redeliverEmail(input: { readonly operationId: string; readonly clockId: string; readonly messageId: string }, ctx: ActionContext): Promise<{ readonly redelivered: true }>;
}

export interface SimMailPort {
  /** `sim_reply` with `mode: SEND_NOW`: the supplier's registered mailbox writes to the operation's address. */
  sendNow(input: { readonly operationId: string; readonly clockId: string; readonly docTypes: readonly DocType[]; readonly version: number; readonly body?: string; readonly mailId: string }, ctx: ActionContext): Promise<void>;
}

export interface WorkerPort {
  /** A `POISON` event with its `ADD` in `inFlight`, like every producer. */
  poison(input: { readonly operationId: string; readonly clockId: string; readonly eventId: string }, ctx: ActionContext): Promise<void>;
  /** The next turn of the operation fails as if the Harness timed out (FL-097). */
  forceNextTurnFailure(input: { readonly operationId: string; readonly clockId: string }, ctx: ActionContext): Promise<void>;
  /** A `HEALTH_PROBE` through the queue: the worker's role calls the reader and writes `PROBE#<probeId>`. */
  healthProbe(input: { readonly probeId: string }, ctx: ActionContext): Promise<void>;
  /** Dispatches a timer with a stale version (FL-064): the worker must ignore it. */
  fireStale(input: { readonly operationId: string; readonly clockId: string; readonly timerKey: string; readonly version: number }, ctx: ActionContext): Promise<void>;
}

export interface FencePort {
  /** Recipient fence and contact policy for an address, in test mode: never calls SES or EUM Social. */
  probe(input: QaParsedInput<"fence.probe">, ctx: ActionContext): Promise<{ readonly allowed: boolean; readonly ruleIds: readonly string[]; readonly reason?: string }>;
}

export interface BatchPort {
  run(input: QaParsedInput<"batch.run">, ctx: ActionContext): Promise<{ readonly worlds: number; readonly turns: number; readonly costUsd?: number }>;
}

export interface QaPorts {
  readonly worlds: WorldFactoryPort;
  readonly clock: ClockPort;
  readonly channels: ChannelsPort;
  readonly simMail: SimMailPort;
  readonly worker: WorkerPort;
  readonly fence: FencePort;
  readonly batch: BatchPort;
}

function notWired(what: string, owner: string): never {
  throw new ToolError("UNAVAILABLE", `${what} is not wired in this deployment yet (${owner})`, QA_REASON.NOT_WIRED);
}

/** Ports whose owning module is not deployed with the driver: every call answers NOT_WIRED. */
export function unwiredPorts(): QaPorts {
  const off = (what: string, owner: string) => () => Promise.resolve(notWired(what, owner));
  return {
    worlds: { create: off("world.create", "world factory, packages/bff/src/worlds"), destroy: off("world.destroy", "world factory, packages/bff/src/worlds") },
    clock: {
      advance: off("clock.advance", "packages/bff/src/clock"),
      fireMilestone: off("clock.fireMilestone", "packages/bff/src/milestones"),
      unfreeze: off("clock.unfreeze", "packages/bff/src/clock"),
      freeze: off("clock.freeze", "packages/bff/src/clock"),
    },
    channels: {
      whatsappInbound: off("wa.inbound", "packages/bff/src/channels/whatsapp"),
      injectEmail: off("email.inject", "packages/bff/src/channels/email/outbound.ts"),
      redeliverEmail: off("email.redeliver", "packages/bff/src/handlers/inbound-email.ts"),
    },
    simMail: { sendNow: off("supplier.sendNow", "packages/bff/src/sim-mail") },
    worker: {
      poison: off("event.poison", "packages/bff/src/worker"),
      forceNextTurnFailure: off("turn.forceFailure", "packages/bff/src/worker"),
      healthProbe: off("the queue part of probe.mocks", "packages/bff/src/worker"),
      fireStale: off("schedule.fireStale", "packages/bff/src/worker"),
    },
    fence: { probe: off("fence.probe", "packages/bff/src/outbound/recipient-fence.ts and packages/bff/src/policy") },
    batch: { run: off("batch.run", "scripts/metrics and the world factory") },
  };
}
