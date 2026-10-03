// What the `QaDriver` drives but does not own (docs/build-plan.md WP-37): the world factory (WP-31),
// the clock (WP-27), the channel entries and the single SES client (WP-19, WP-20, WP-29), the supplier
// simulator (WP-30), the worker (WP-28), the recipient fence and contact policy (WP-17, WP-25) and the
// metrics batch. Each is a port: the Lambda entry wires the module that owns it (stage-ports.ts), so an
// action never takes a shortcut around policy, Cedar or the outbound pipeline, and the tests drive the
// actions over fakes.
import type { DocType } from "@legajo/shared";
import type { SimulatedContent } from "../channels/whatsapp/sim-envelope";
import type { Connector } from "../connector/index";
import type { Logger } from "../lib/log";
import type { QaActionName } from "./contract";
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

/** The reply a tap on one of our buttons sends (a template's quick reply, a reply button or a list row). */
export type TapContent = Extract<SimulatedContent, { readonly type: "template_reply" | "button_reply" | "list_reply" }>;

/** An inbound WhatsApp as the simulated path receives it; ids resolved by the driver, never by the scenario. */
export type WhatsAppInbound =
  | { readonly type: "text"; readonly text: string }
  /** A tap on a button of the message whose provider id is `contextWamid`. */
  | { readonly type: "tap"; readonly content: TapContent; readonly contextWamid?: string }
  | { readonly type: "document"; readonly docType: DocType; readonly version: number; readonly templateOperation: string }
  | { readonly type: "media"; readonly mediaType: "image" | "audio" | "video" | "sticker" };

export interface EmailInjection {
  readonly clockId: string;
  /** `qainject-<runId>-<scenario>@sim…`, or the registered address of a party of this world. */
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly autoReply: boolean;
  readonly attachments: ReadonlyArray<{ readonly docType: DocType; readonly version: number; readonly templateOperation: string }>;
  /** `X-Legajo-Mail-Id`, derived from the step's key (SES writes the RFC `Message-ID` itself). */
  readonly mailId: string;
  readonly operationId?: string;
}

export interface ChannelsPort {
  /** Same entry as the phone simulator: the SNS envelope `InboundWhatsApp` verifies. */
  whatsappInbound(input: { readonly operationId: string; readonly clockId: string; readonly from: "IMPORTER" | "UNREGISTERED"; readonly wamid: string; readonly message: WhatsAppInbound }, ctx: ActionContext): Promise<{ readonly messageId?: string }>;
  /** The single SES client with profile `QA` (it checks the `From` against the registry). */
  injectEmail(input: EmailInjection, ctx: ActionContext): Promise<{ readonly sesMessageId: string }>;
  /** `InboundEmail` again with the same receipt and the same S3 object; its answer (`DUPLICATE` expected). */
  redeliverEmail(
    input: { readonly operationId: string; readonly clockId: string; readonly messageId: string },
    ctx: ActionContext,
  ): Promise<{ readonly redelivered: true; readonly outcome: string | null; readonly reason: string | null }>;
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

/** Where a `batch.run` call left the batch: a stopped call is resumed by the next one with the same batch id. */
export interface BatchProgress {
  readonly batchId: string;
  readonly entries: number;
  /** Entries whose world ran to the end (nothing pending, the dossier settled). */
  readonly finished: number;
  readonly turns: number;
  /** Estimated from the worlds' tokens and the rate card; absent while the rates are unverified. */
  readonly costUsd?: number;
  /** Why this call stopped before the last entry. */
  readonly stopped?: "MAX_TURNS" | "MAX_COST" | "DEADLINE";
}

export interface BatchPort {
  run(input: QaParsedInput<"batch.run">, ctx: ActionContext): Promise<BatchProgress>;
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
