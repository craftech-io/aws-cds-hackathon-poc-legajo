// Fixtures of the `messaging` tool tests: the outbound pipeline's test world (outbound/testing.ts) with
// the `messaging` target built over the same in-memory connector, and turns opened the way the worker
// opens them (session + turn rows + signed token) at the simulated instant the test needs, with the
// tool results the turn already holds.
import type { TurnTrigger } from "@legajo/shared";
import { REAL_NOW } from "../../connector/testing";
import { createLogger } from "../../lib/log";
import { outboundWorld, type OutboundWorld } from "../../outbound/testing";
import { issueSessionToken } from "../../services/session";
import { TEST_SESSION_KEY } from "../common/testing";
import type { GatewayTargetRuntime, ToolDeps } from "../common/handler";
import { gatewayContext } from "../common/principal";
import type { ToolResponse } from "../common/context";
import { messagingImplementations } from "./handler";
import { createMessagingTarget } from "./index";

export interface MessagingWorld extends OutboundWorld {
  readonly target: GatewayTargetRuntime;
  /** Opens a turn at `eventAtSim` holding `results`; answers its signed token and turn id. */
  open(trigger: TurnTrigger, eventAtSim: string, results?: readonly { readonly tool: string; readonly output: Record<string, unknown> }[]): Promise<{ readonly token: string; readonly turnId: string }>;
  /** A call through the Gateway, as the Harness makes it. */
  gateway(tool: string, input: Record<string, unknown>): Promise<ToolResponse>;
}

export async function messagingWorld(options: Parameters<typeof outboundWorld>[0] = {}): Promise<MessagingWorld> {
  const world = await outboundWorld(options);
  const { connector } = world.stores;
  const wall = new Date(REAL_NOW);
  const deps: ToolDeps = {
    connector,
    sessionKey: () => TEST_SESSION_KEY,
    wallClock: () => new Date(wall.getTime()),
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => world.lines.push(line), now: () => wall }),
  };
  const target = createMessagingTarget(deps, messagingImplementations({ outbound: () => world.deps }));
  let turns = 0;
  return {
    ...world,
    target,
    async open(trigger, eventAtSim, results = []) {
      turns += 1;
      const id = `M${String(turns).padStart(4, "0")}`;
      const sessionId = `ses-${id}`;
      const turnId = `turn-${id}`;
      await connector.runtime.putSession({ sessionId, turnId, operationId: "op-4471", firmId: "firm-delta", importerId: "imp-norpampa", supplierId: "sup-qingdao", trigger, clockId: "GLOBAL#firm-delta", eventAtSim, worldEpoch: 1, sessionEpoch: 0 });
      await connector.runtime.openTurn({ turnId, sessionId, operationId: "op-4471", clockId: "GLOBAL#firm-delta", trigger, openedAtReal: REAL_NOW });
      for (const result of results) await connector.runtime.appendTurnResult({ turnId, tool: result.tool, output: result.output, atReal: REAL_NOW });
      return { token: issueSessionToken(TEST_SESSION_KEY, { sessionId, turnId }, wall.getTime()).token, turnId };
    },
    gateway: (tool, input) => target.handle(input, gatewayContext(`messaging___${tool}`)),
  };
}

export const DOSSIER = {
  operationNumber: "4471",
  firmName: "Estudio Delta",
  vessel: "Austral Aurora",
  etaText: "22/10",
  invoiceNumber: "QBT-2026-0917",
  missingDocuments: "certificado de origen y packing list",
  deadlines: { supplier: { text: "October 19, 10:00 (Asia/Shanghai)" } },
};
