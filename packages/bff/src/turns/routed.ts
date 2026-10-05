// After an `IMPORTER_MESSAGE` turn (ADR-0017): when the agent called `route_to_operation`, the
// importer's message moves to that operation and its turn runs there. The tool only checked the target
// (agent-tools/messaging/route-operation.ts); this is the side the worker owns, with its queue:
//
//   1. the turn's last successful `route_to_operation` result names the target operation;
//   2. the message is the turn's own inbound original (a copy, `routedFrom`, never moves again, so no
//      two turns can bounce a message back and forth);
//   3. the target is still an operation of the same importer and world;
//   4. a copy of the message lands in the target (`routedFrom` → the original), and the target's
//      `IMPORTER_MESSAGE` turn is enqueued with its own event id (the original's id already ran).
//
// Both turns run in the importer's conversation session (turns/identity.ts), so Memory sees one chat.
import { importerTurn, appendInbound } from "../channels/whatsapp/records";
import { turnEventId } from "../channels/adapter";
import type { Connector } from "../connector/index";
import type { Operation } from "../domain/operations";
import type { WorkerContext } from "../worker/ports";
import type { TurnEvent } from "../worker/events";

export const ROUTE_TOOL_NAME = "route_to_operation";

export interface RouteFollowed {
  readonly operationId: string;
  readonly messageId: string;
}

/** Operation id of the turn's last successful `route_to_operation`, if any. */
export async function routedTargetOf(data: Pick<Connector, "runtime">, turnId: string): Promise<string | undefined> {
  const results = await data.runtime.listTurnResults(turnId);
  const routes = results.filter((result) => result.tool === ROUTE_TOOL_NAME && result.output["ok"] === true && typeof result.output["operationId"] === "string");
  return routes.at(-1)?.output["operationId"] as string | undefined;
}

/** Copies the importer's original message into `targetId` and enqueues that operation's turn (steps 2 to 4). */
export async function moveToOperation(
  data: Connector,
  ctx: Pick<WorkerContext, "sink" | "log">,
  input: { readonly operation: Operation; readonly messageId: string; readonly eventAtSim: string; readonly targetId: string },
): Promise<RouteFollowed | undefined> {
  const { operation } = input;
  const source = await data.conversations.getMessage(operation.operationId, input.messageId);
  if (source === undefined || source.interactive?.routedFrom !== undefined || source.providerMessageId === undefined) return undefined;
  const target = await data.operations.findOperation(input.targetId);
  if (target === undefined || target.operationId === operation.operationId || target.importerId !== operation.importerId || target.clockId !== operation.clockId) {
    ctx.log.warn("turn.route_dropped", { operationId: operation.operationId, reason: "TARGET_NOT_OF_IMPORTER" });
    return undefined;
  }
  const importer = await data.parties.getImporter(operation.importerId);
  const copy = await appendInbound(data, {
    wamid: source.providerMessageId,
    importer,
    operationId: target.operationId,
    to: source.to,
    body: { text: source.body, truncated: source.truncated },
    simulated: source.simulated,
    sentAtSim: source.sentAtSim,
    sentAtReal: source.sentAtReal,
    attachments: source.attachments,
    routedFrom: { operationId: source.operationId, messageId: source.messageId },
  });
  const turn = importerTurn({ importer, operationId: target.operationId, messageId: copy.messageId, wamid: source.providerMessageId, atSim: input.eventAtSim });
  await ctx.sink.enqueue({ ...turn, eventId: turnEventId("IMPORTER_MESSAGE", `${source.providerMessageId}#to#${target.operationId}`) });
  ctx.log.info("turn.routed", { from: operation.operationId, to: target.operationId });
  return { operationId: target.operationId, messageId: copy.messageId };
}

export async function followRoute(data: Connector, ctx: Pick<WorkerContext, "sink" | "log">, input: { readonly operation: Operation; readonly event: TurnEvent; readonly turnId: string }): Promise<RouteFollowed | undefined> {
  const { operation, event } = input;
  if (event.trigger !== "IMPORTER_MESSAGE" || event.messageId === undefined) return undefined;
  const targetId = await routedTargetOf(data, input.turnId);
  if (targetId === undefined) return undefined;
  return moveToOperation(data, ctx, { operation, messageId: event.messageId, eventAtSim: event.eventAtSim, targetId });
}
