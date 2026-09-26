// The in-process world of the local flows (docs/test-plan.md §3, "Flujos locales"): the connector
// over memory, the demo slice of the seed with its firms, brokers and paused clocks, the reader and
// the platform mocks in process, every AWS client faked at `send` (fakes/aws.ts), the stage's Cedar
// statements in front of the Gateway targets and a scripted Harness that answers `InvokeHarness`.
// The console is the real `appRouter` with a principal built on the server.
//
// Real time is fixed and only moves when a test moves it; simulated time is the world's clock
// (`Runtime/CLOCK#`), which only the clock module moves (ADR-0007). The entries of the stage and the
// Gateway targets are ports (ports.ts): the world wires what exists and names what does not.
import { createTestIssuer, testContextDeps } from "@legajo/bff/auth/testing";
import type { Principal } from "@legajo/bff/auth/principal";
import { createMemoryStores, type Connector, type MemoryStores } from "@legajo/bff/connector/index";
import { CLOCK, FIRM, REAL_NOW } from "@legajo/bff/connector/testing";
import type { Session, Turn } from "@legajo/bff/domain/runtime";
import { simNowOf } from "@legajo/bff/lib/clock";
import { deriveSubkey, sha256Hex, ulid } from "@legajo/bff/lib/crypto";
import { createConsoleCaller } from "@legajo/bff/routers/index";
import { DIEGO, seedConsoleWorld } from "@legajo/bff/routers/testing";
import { serverContext } from "@legajo/bff/routers/trpc";
import { issueSessionToken } from "@legajo/bff/services/session";
import { operationNumberOf, type TurnTrigger } from "@legajo/shared";
import { platformFixture, type PlatformFixture } from "@legajo/platform-mock/testing";
import { testEnvelope } from "./envelope";
import { installAwsFakes, type AwsFakes } from "./fakes/aws";
import { inProcessReader, type InProcessReader } from "./fakes/reader";
import { createLocalGateway, localPolicies, type LocalGateway } from "./gateway";
import { unwiredEntries, unwiredTargets, type FlowEntries, type ToolTargetsPort } from "./ports";
import { createScriptedHarness, type PlanSource, type ScriptedHarness } from "./scripted-harness";

/** Master key of every local world; the stage's comes from `SessionTokenKey` (infra/secrets.ts). */
export const LOCAL_MASTER_KEY = new TextEncoder().encode("legajo-local-flows-master-key-v1");

export interface FlowWorldOptions {
  /** Real time of the world (fixed); the demo slice's stamp by default. */
  readonly realNow?: string;
  /** Plans of the scripted Harness, one per turn it answers. */
  readonly plans?: PlanSource;
  readonly targets?: ToolTargetsPort;
  readonly entries?: FlowEntries;
  readonly killSwitchActive?: boolean;
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

export type ConsoleCaller = ReturnType<typeof createConsoleCaller>;

export interface FlowWorld {
  readonly stores: MemoryStores;
  readonly data: Connector;
  /** Demo world of the slice: `GLOBAL#firm-delta` of `firm-delta`. */
  readonly clockId: string;
  readonly firmId: string;
  readonly aws: AwsFakes;
  readonly reader: InProcessReader;
  readonly platform: PlatformFixture;
  readonly gateway: LocalGateway;
  readonly harness: ScriptedHarness;
  readonly entries: FlowEntries;
  realNow(): Date;
  advanceReal(ms: number): void;
  /** Simulated "now" of a world's clock (the demo world's by default). */
  simNow(clockId?: string): Promise<Date>;
  /** The console as `principal` sees it (the firm's broker by default). */
  console(principal?: Principal): ConsoleCaller;
  /** HKDF subkey of the world's master key (lib/crypto.ts purposes). */
  subkey(purpose: Parameters<typeof deriveSubkey>[1]): Uint8Array;
  /**
   * A session and an open turn for an operation, and the envelope's session and event lines: what a
   * test needs to hand the scripted Harness a turn itself. A turn of the worker opens its own.
   */
  openTurn(input: OpenTurnInput): Promise<OpenedTurn>;
  /** Takes the AWS stubs off; call it when the test ends. */
  close(): void;
}

export async function createFlowWorld(options: FlowWorldOptions = {}): Promise<FlowWorld> {
  let realMs = Date.parse(options.realNow ?? REAL_NOW);
  const realNow = () => new Date(realMs);
  const stores = createMemoryStores({ now: realNow });
  await seedConsoleWorld(stores);
  const gateway = createLocalGateway({
    targets: options.targets ?? unwiredTargets(),
    policies: localPolicies({ killSwitchActive: options.killSwitchActive ?? false }),
  });
  const harness = createScriptedHarness({
    gateway,
    plans:
      options.plans ??
      ((envelope) => {
        throw new Error(`the test scripted no plan for the ${envelope.event.type} turn of ${envelope.event.operation}`);
      }),
  });
  const deps = testContextDeps({ verifier: createTestIssuer({ now: realNow }).verifier(), stores, now: realNow });
  const subkey = (purpose: Parameters<typeof deriveSubkey>[1]) => deriveSubkey(LOCAL_MASTER_KEY, purpose);
  const simNow = async (clockId: string = CLOCK) => simNowOf(await stores.connector.world.getClock(clockId), realMs);
  // Last, so a world that fails to build never leaves the stubs installed.
  const aws = installAwsFakes({ now: realNow });
  aws.answerHarness((input) => harness.invoke(input));

  return {
    stores,
    data: stores.connector,
    clockId: CLOCK,
    firmId: FIRM,
    aws,
    reader: inProcessReader({ objects: aws.objects, now: realNow }),
    platform: platformFixture({ deps: { now: realNow } }),
    gateway,
    harness,
    entries: options.entries ?? unwiredEntries(),
    realNow,
    advanceReal(ms) {
      realMs += ms;
    },
    simNow,
    console: (principal = DIEGO) => createConsoleCaller(serverContext({ principal, deps })),
    subkey,
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
      const turn = await stores.connector.runtime.openTurn({ turnId, sessionId, operationId: operation.operationId, clockId: operation.clockId, trigger: input.trigger, openedAtReal: realNow().toISOString() });
      const { token } = issueSessionToken(subkey("session"), { sessionId, turnId }, realMs);
      const envelope = testEnvelope({ sessionToken: token, type: input.trigger, id: `evt_${sha256Hex(turnId).slice(0, 16)}`, at: eventAtSim, operation: operationNumberOf(operation.operationId) });
      return { session, turn, sessionToken: token, envelope };
    },
    close: () => aws.restore(),
  };
}
