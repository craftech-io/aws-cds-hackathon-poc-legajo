// Fixtures of the tool-wrapper tests: the demo slice of connector/testing.ts (firm `firm-delta`, operation
// `op-4471`, importer `imp-norpampa`, supplier `sup-qingdao`) in memory, its paused clock, a signing key,
// turns opened the way the worker opens them (session + turn rows + signed token) and a logger whose
// lines the test can read.
import { ok, type TurnTrigger } from "@legajo/shared";
import { CLOCK, FIRM, REAL_NOW, START_SIM, memoryStores, operationFixture, seedDemoSlice } from "../../connector/testing";
import type { MemoryStores } from "../../connector/memory/index";
import { createLogger } from "../../lib/log";
import { issueSessionToken } from "../../services/session";
import type { ToolContext, ToolImplementation, ToolResponse } from "./context";
import type { ToolDeps } from "./handler";

/** A test key of the `session` subkey's length; never a real one. */
export const TEST_SESSION_KEY = "test-session-subkey-0123456789abcdef0123456789";

export const OPERATION = "op-4471";
/** Another operation of the same firm and parties. */
export const OTHER_OPERATION = "op-4472";
/** An operation of another firm. */
export const FOREIGN_OPERATION = "op-5501";

export interface OpenedTurn {
  readonly token: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface ToolWorld {
  readonly stores: MemoryStores;
  readonly deps: ToolDeps;
  /** Every JSON log line written during the test. */
  readonly logs: string[];
  openTurn(trigger: TurnTrigger, options?: { readonly id?: string; readonly eventId?: string }): Promise<OpenedTurn>;
  closeTurn(turnId: string): Promise<void>;
}

export async function toolWorld(): Promise<ToolWorld> {
  const stores = memoryStores();
  await seedDemoSlice(stores);
  const { connector } = stores;
  await connector.operations.createOperation(operationFixture({ operationNumber: "4472", threadTag: "m3n8r2" }));
  await connector.operations.createOperation(operationFixture({ operationNumber: "5501", firmId: "firm-norte", clockId: "GLOBAL#firm-norte", threadTag: "z9y8x7" }));
  await connector.world.createClock({ clockId: CLOCK, firmId: FIRM, mode: "PAUSED", pausedSimNow: START_SIM, startAtSim: START_SIM, worldEpoch: 1 });
  const logs: string[] = [];
  const wall = new Date(REAL_NOW);
  const deps: ToolDeps = {
    connector,
    sessionKey: () => TEST_SESSION_KEY,
    wallClock: () => new Date(wall.getTime()),
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => logs.push(line), now: () => wall }),
  };
  let turns = 0;
  return {
    stores,
    deps,
    logs,
    async openTurn(trigger, options = {}) {
      turns += 1;
      const id = options.id ?? `T${String(turns).padStart(4, "0")}`;
      const sessionId = `ses-${id}`;
      const turnId = `turn-${id}`;
      await connector.runtime.putSession({
        sessionId,
        turnId,
        operationId: OPERATION,
        firmId: FIRM,
        importerId: "imp-norpampa",
        supplierId: "sup-qingdao",
        trigger,
        clockId: CLOCK,
        eventAtSim: START_SIM,
        worldEpoch: 1,
        sessionEpoch: 0,
        ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
      });
      await connector.runtime.openTurn({ turnId, sessionId, operationId: OPERATION, clockId: CLOCK, trigger, openedAtReal: REAL_NOW });
      const { token } = issueSessionToken(TEST_SESSION_KEY, { sessionId, turnId }, wall.getTime());
      return { token, sessionId, turnId };
    },
    async closeTurn(turnId) {
      await connector.runtime.closeTurn(turnId, REAL_NOW);
    },
  };
}

export interface Recording {
  readonly calls: ToolContext<unknown>[];
  readonly implementation: ToolImplementation<unknown>;
}

/** An implementation that records its context and answers `answer` (a small ok by default). */
export function recording(answer: (ctx: ToolContext<unknown>) => ToolResponse | Promise<ToolResponse> = (ctx) => ok({ tool: ctx.tool })): Recording {
  const calls: ToolContext<unknown>[] = [];
  return {
    calls,
    implementation: async (ctx) => {
      calls.push(ctx);
      return answer(ctx);
    },
  };
}

/** The `AuditLog` rows of the demo firm, oldest first. */
export async function auditRows(world: ToolWorld, firmId: string = FIRM): Promise<Awaited<ReturnType<ToolWorld["stores"]["connector"]["audit"]["listByMonth"]>>> {
  const months = ["2026-09", "2026-10"];
  const rows = (await Promise.all(months.map((month) => world.stores.connector.audit.listByMonth(firmId, month)))).flat();
  return rows.sort((a, b) => a.ts.localeCompare(b.ts));
}
