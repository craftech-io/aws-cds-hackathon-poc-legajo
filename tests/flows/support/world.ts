// The in-process world of the local flows (docs/test-plan.md §3, "Flujos locales"): the real seed
// loaded into the in-memory connector by `seed:load` (seed-world.ts: `GLOBAL#firm-delta` built from its
// template, the static rows, the reader's catalog), the stage's own modules wired over it (stage/), every
// AWS client faked at `send` (fakes/aws.ts), the reader and the platform mocks in process, the stage's
// Cedar statements in front of the Gateway targets and a scripted Harness that answers `InvokeHarness`.
// The console is the real `appRouter` with the console services bound to the same stage.
//
// Real time is fixed and only moves when a test moves it; simulated time is each world's clock
// (`Runtime/CLOCK#`), which only the clock module moves (ADR-0007).
import type { Principal } from "@legajo/bff/auth/principal";
import { createMemoryStores, type Connector, type MemoryStores } from "@legajo/bff/connector/index";
import { importerCounterpartKey } from "@legajo/bff/connector/keys";
import { REAL_NOW } from "@legajo/bff/connector/testing";
import type { Message } from "@legajo/bff/domain/conversations";
import type { Session, Turn } from "@legajo/bff/domain/runtime";
import { simNowOf } from "@legajo/bff/lib/clock";
import { type SubkeyPurpose, sha256Hex, ulid } from "@legajo/bff/lib/crypto";
import { createLogger } from "@legajo/bff/lib/log";
import { DIEGO } from "@legajo/bff/routers/testing";
import { issueSessionToken } from "@legajo/bff/services/session";
import type { SimulatedContent } from "@legajo/bff/channels/whatsapp/sim-envelope";
import { type PhoneSimulatorDeps, sendFromPhone, tapContent } from "@legajo/bff/channels/whatsapp/simulator";
import type { InboundSummary } from "@legajo/bff/channels/whatsapp/inbound";
import type { WorldsDeps } from "@legajo/bff/worlds/deps";
import { type MilestoneName, operationNumberOf, type TurnTrigger, type WaButtonAction } from "@legajo/shared";
import { fireMilestoneNow } from "@legajo/bff/clock/advance";
import { testEnvelope } from "./envelope";
import { installAwsFakes, type AwsFakes, type GuardrailScript, type HarnessResponder } from "./fakes/aws";
import { inProcessReader, type InProcessReader } from "./fakes/reader";
import { createLocalGateway, localPolicies, type LocalGateway } from "./gateway";
import type { ToolTargetsPort } from "./ports";
import { createScriptedHarness, type PlanSource, type ScriptedHarness } from "./scripted-harness";
import { loadDemoSeed, localWorldsDeps, mapSeedPdfStore, seedOnDisk, type SeedBucketObjects } from "./seed-world";
import { type ConsoleCaller, type LocalPlatform, createLocalConsole, createLocalPlatform } from "./stage/console";
import { type StageContext, createStageContext, localScheduler, stageTargets } from "./stage/context";
import { moveToOperation } from "../../../packages/bff/src/turns/routed";
import { type LocalEntries, createLocalEntries, simMailDeps, simReplyHandoff } from "./stage/entries";
import { createStageWorker } from "./stage/worker";

export type { ConsoleCaller };

/** Master key of every local world; the stage's comes from `SessionTokenKey` (infra/secrets.ts). */
export const LOCAL_MASTER_KEY = new TextEncoder().encode("legajo-local-flows-master-key-v1");
export const DEMO_CLOCK = "GLOBAL#firm-delta";
export const DEMO_FIRM = "firm-delta";
/** Real time between two things a person does on the phone (a tap, a text): every one is a later instant. */
const PHONE_PAUSE_MS = 1_000;

export interface FlowWorldOptions {
  /** Real time of the world (fixed). */
  readonly realNow?: string;
  /** Plans of the scripted Harness, one per turn it answers. */
  readonly plans?: PlanSource;
  /** The Gateway targets; the stage's own (stage/context.ts) unless a test records the calls instead. */
  readonly targets?: ToolTargetsPort;
  readonly killSwitchActive?: boolean;
  /** G1 and G2 answers; everything passes by default. */
  readonly guardrail?: GuardrailScript;
  /** A model-backed Harness over the world's Gateway (tests/agent); the scripted one answers otherwise. */
  readonly agent?: (gateway: LocalGateway) => HarnessResponder;
}

export interface OpenTurnInput {
  readonly operationId: string;
  readonly trigger: TurnTrigger;
  /** Simulated instant of the event; the world's "now" by default. */
  readonly eventAtSim?: string;
}

export interface OpenedTurn {
  readonly session: Session;
  readonly turn: Turn;
  readonly sessionToken: string;
  readonly envelope: string;
}

/** A message of the phone simulator: its `wamid` and what `InboundWhatsApp` answered. */
export interface PhoneSent {
  readonly wamid: string;
  readonly summary: InboundSummary;
}

export interface FlowWorld {
  readonly stores: MemoryStores;
  readonly data: Connector;
  /** Demo world of the seed: `GLOBAL#firm-delta` of `firm-delta`. */
  readonly clockId: string;
  readonly firmId: string;
  readonly aws: AwsFakes;
  readonly reader: InProcessReader;
  readonly platform: LocalPlatform;
  readonly gateway: LocalGateway;
  readonly harness: ScriptedHarness;
  readonly entries: LocalEntries;
  readonly stage: StageContext;
  readonly worlds: WorldsDeps;
  readonly seed: SeedBucketObjects;
  /** JSON log lines of warning level and above the stage's modules wrote (no PII by construction). */
  readonly logs: readonly string[];
  realNow(): Date;
  advanceReal(ms: number): void;
  /** Simulated "now" of a world's clock (the demo world's by default). */
  simNow(clockId?: string): Promise<Date>;
  /** The console as `principal` sees it (the firm's broker by default). */
  console(principal?: Principal): ConsoleCaller;
  /** HKDF subkey of the world's master key (lib/crypto.ts purposes). */
  subkey(purpose: SubkeyPurpose): Uint8Array;
  /** The importer's phone in the simulator: free text, a document, or any content, delivered to `InboundWhatsApp`; then settles. */
  phone(phoneE164: string, content: SimulatedContent, contextWamid?: string): Promise<PhoneSent>;
  /** Taps a button of the last WhatsApp of `operationId` that offers `action`; answers the reply's `wamid`. */
  tap(operationId: string, action: WaButtonAction): Promise<PhoneSent>;
  /** Picks `operationNumber` in the last `OPERATION_CHOICE` list the importer got (FL-019); then settles. */
  choose(importerId: string, operationNumber: string): Promise<PhoneSent>;
  /**
   * The importer writes `text` about `operationNumber`: with one open operation it goes straight there;
   * with several, the importer picks it in the `OPERATION_CHOICE` list the text gets back (FL-019).
   * Answers the id of the importer's message in that operation.
   */
  say(importerId: string, operationNumber: string, text: string): Promise<string>;
  /** What the agent's `route_to_operation` does (ADR-0017): moves a delivered message to `operationNumber` and settles; answers the copy's id. */
  route(landed: { readonly operationId: string; readonly messageId: string }, operationNumber: string): Promise<string>;
  /** Registered phone of an importer of the seed. */
  phoneOf(importerId: string): Promise<string>;
  /** Messages of an operation in `sentAtSim` order. */
  messages(operationId: string): Promise<Message[]>;
  /** Moves a paused clock (`advance_clock` as the `QaDriver` calls it) and settles the world. */
  advance(move: { readonly byMinutes: number } | { readonly to: string } | { readonly next: true }, clockId?: string): Promise<void>;
  /** "Disparar ahora" of a pending milestone at the world's now (`firedBy MANUAL`), then settles the world. */
  fire(operationId: string, milestone: MilestoneName): Promise<void>;
  /** A session and an open turn for an operation, and the envelope's session and event lines. */
  openTurn(input: OpenTurnInput): Promise<OpenedTurn>;
  /** Takes the AWS stubs off; call it when the test ends. */
  close(): void;
}

export async function createFlowWorld(options: FlowWorldOptions = {}): Promise<FlowWorld> {
  let realMs = Date.parse(options.realNow ?? REAL_NOW);
  const now = () => new Date(realMs);
  const logs: string[] = [];
  const log = createLogger({ level: "warn", now, sink: (line) => void logs.push(line) });
  const stores = createMemoryStores({ now });
  const aws = installAwsFakes({ now });
  try {
    const reader = inProcessReader({ objects: aws.objects, now });
    reader.catalog.load(seedOnDisk().tables.ReaderCatalog.items as never);
    let stage: StageContext | undefined;
    let platform: LocalPlatform | undefined;
    let entries: LocalEntries | undefined;
    const lateStage = () => stage as StageContext;
    const worlds = localWorldsDeps({ stores, master: LOCAL_MASTER_KEY, scheduler: localScheduler(), now, log });
    const seed = await loadDemoSeed(worlds);
    const seedPdfs = mapSeedPdfStore(seed);
    platform = createLocalPlatform(stores, now, async (envelope) => void (await (entries as LocalEntries).feedEvent(envelope)));
    stage = createStageContext({
      stores,
      data: stores.connector,
      aws,
      reader,
      master: LOCAL_MASTER_KEY,
      now,
      log,
      simReply: simReplyHandoff(() => simMailDeps(lateStage(), seedPdfs)),
      platform: { get: (firmId, operationNumber) => (platform as LocalPlatform).get(firmId, operationNumber) },
    });
    const worker = createStageWorker(stage);
    entries = createLocalEntries(stage, worker, seedPdfs);
    const gateway = createLocalGateway({ targets: options.targets ?? stageTargets(stage), policies: localPolicies({ killSwitchActive: options.killSwitchActive ?? false }) });
    const harness = createScriptedHarness({
      gateway,
      plans:
        options.plans ??
        ((envelope) => {
          throw new Error(`the test scripted no plan for the ${envelope.event.type} turn of ${envelope.event.operation}`);
        }),
    });
    aws.answerHarness(options.agent === undefined ? (input) => harness.invoke(input) : options.agent(gateway));
    if (options.guardrail !== undefined) aws.scriptGuardrail(options.guardrail);
    const subkey = (purpose: SubkeyPurpose) => (stage as StageContext).key(purpose);
    const simNow = async (clockId: string = DEMO_CLOCK) => simNowOf(await stores.connector.world.getClock(clockId), realMs);
    const phoneDeps = (): PhoneSimulatorDeps => ({ simEnvelopeKey: subkey("sim-envelope"), delivery: { deliver: (event) => (entries as LocalEntries).inboundWhatsApp(event) }, realClock: { now: async () => now() } });
    const consoleOf = createLocalConsole(stage, worlds, platform, phoneDeps, seed);
    const settle = () => (entries as LocalEntries).settle();
    const messages = async (operationId: string) => [...(await stores.connector.conversations.listMessages(operationId))].sort((a, b) => Date.parse(a.sentAtSim) - Date.parse(b.sentAtSim));

    const route = async (landed: { readonly operationId: string; readonly messageId: string }, operationNumber: string): Promise<string> => {
      const operation = await stores.connector.operations.getOperation(landed.operationId);
      const source = await stores.connector.conversations.getMessage(landed.operationId, landed.messageId);
      const eventAtSim = source?.sentAtSim ?? (await simNow()).toISOString();
      const moved = await moveToOperation(stores.connector, { sink: (stage as StageContext).sink, log }, { operation, messageId: landed.messageId, eventAtSim, targetId: `op-${operationNumber}` });
      await settle();
      return moved?.messageId ?? "";
    };

    const choose = async (importerId: string, operationNumber: string): Promise<PhoneSent> => {
      const importer = await stores.connector.parties.getImporter(importerId);
      const lists = (await stores.connector.conversations.listCounterpartMessages(importerCounterpartKey(importerId), { direction: "OUT" })).filter((message) => message.kind === "OPERATION_CHOICE");
      const list = lists.sort((a, b) => Date.parse(a.sentAtReal) - Date.parse(b.sentAtReal)).at(-1);
      const row = list?.buttons.find((button) => button.title.includes(operationNumber));
      if (list === undefined || row === undefined) throw new Error(`${importerId} has no choice list with ${operationNumber}`);
      realMs += PHONE_PAUSE_MS;
      const sent = await sendFromPhone(phoneDeps(), { phoneE164: importer.phoneE164, content: tapContent(list, row), ...(list.providerMessageId === undefined ? {} : { contextWamid: list.providerMessageId }) });
      await settle();
      return { wamid: sent.wamid, summary: sent.summary as InboundSummary };
    };

    return {
      stores,
      data: stores.connector,
      clockId: DEMO_CLOCK,
      firmId: DEMO_FIRM,
      aws,
      reader,
      platform,
      gateway,
      harness,
      entries,
      stage,
      worlds,
      seed,
      logs,
      realNow: now,
      advanceReal(ms) {
        realMs += ms;
      },
      simNow,
      console: (principal = DIEGO) => consoleOf.caller(principal),
      subkey,
      async phone(phoneE164, content, contextWamid) {
        realMs += PHONE_PAUSE_MS;
      const sent = await sendFromPhone(phoneDeps(), { phoneE164, content, ...(contextWamid === undefined ? {} : { contextWamid }) });
        await settle();
        return { wamid: sent.wamid, summary: sent.summary as InboundSummary };
      },
      async tap(operationId, action) {
        const offering = (await messages(operationId)).filter((message) => message.direction === "OUT" && message.channel === "WHATSAPP" && (message.buttons ?? []).some((button) => button.action === action));
        const message = offering.at(-1);
        const button = message?.buttons?.find((candidate) => candidate.action === action);
        if (message === undefined || button === undefined) throw new Error(`no WhatsApp of ${operationId} offers ${action}`);
        const importer = await stores.connector.parties.getImporter(message.importerId ?? "");
        realMs += PHONE_PAUSE_MS;
      const sent = await sendFromPhone(phoneDeps(), { phoneE164: importer.phoneE164, content: tapContent(message, button), ...(message.providerMessageId === undefined ? {} : { contextWamid: message.providerMessageId }) });
        await settle();
        return { wamid: sent.wamid, summary: sent.summary as InboundSummary };
      },
      choose,
      async say(importerId, operationNumber, text) {
        const importer = await stores.connector.parties.getImporter(importerId);
        realMs += PHONE_PAUSE_MS;
        const sent = await sendFromPhone(phoneDeps(), { phoneE164: importer.phoneE164, content: { type: "text", text } });
        await settle();
        const first = (sent.summary as InboundSummary).records[0]?.messages[0];
        const operationId = `op-${operationNumber}`;
        if (first?.messageId === undefined || first.operationId === undefined || first.operationId === operationId) return first?.messageId ?? "";
        // The text landed in the operation the chat was about (ADR-0017); the agent would move it with
        // route_to_operation, and the scripted world does the same for the test.
        return route({ operationId: first.operationId, messageId: first.messageId }, operationNumber);
      },
      route,
      phoneOf: async (importerId) => (await stores.connector.parties.getImporter(importerId)).phoneE164,
      messages,
      async advance(move, clockId = DEMO_CLOCK) {
        await (entries as LocalEntries).advanceClock(clockId, move);
        await settle();
      },
      async fire(operationId, milestone) {
        await fireMilestoneNow({ operationId, milestone, caller: { actor: "QA" } }, (stage as StageContext).timerDeps());
        await settle();
      },
      async openTurn(input) {
        const operation = await stores.connector.operations.getOperation(input.operationId);
        const eventAtSim = input.eventAtSim ?? (await simNow(operation.clockId)).toISOString();
        const sessionId = ulid(realMs);
        const turnId = ulid(realMs + 1);
        const session = await stores.connector.runtime.putSession({
          sessionId,
          turnId,
          operationId: operation.operationId,
          firmId: operation.firmId,
          importerId: operation.importerId,
          supplierId: operation.supplierId,
          trigger: input.trigger,
          clockId: operation.clockId,
          eventAtSim,
          worldEpoch: operation.worldEpoch,
          sessionEpoch: operation.sessionEpoch,
        });
        const turn = await stores.connector.runtime.openTurn({ turnId, sessionId, operationId: operation.operationId, clockId: operation.clockId, trigger: input.trigger, openedAtReal: now().toISOString() });
        const { token } = issueSessionToken(subkey("session"), { sessionId, turnId }, realMs);
        const envelope = testEnvelope({ sessionToken: token, type: input.trigger, id: `evt_${sha256Hex(turnId).slice(0, 16)}`, at: eventAtSim, operation: operationNumberOf(operation.operationId) });
        return { session, turn, sessionToken: token, envelope };
      },
      close: () => aws.restore(),
    };
  } catch (error) {
    aws.restore();
    throw error;
  }
}
