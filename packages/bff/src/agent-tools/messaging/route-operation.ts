// `route_to_operation` (ADR-0017, docs/tool-catalog.md): the importer's message of this turn is about
// another of their open operations. Only in an `IMPORTER_MESSAGE` turn (`LAM-TRIGGER`). The tool only
// checks and answers; the worker, when the turn closes, copies the message into that operation and runs
// its turn there (turns/routed.ts), in the same conversation session, so Memory keeps the chat.
//
// The target is named by `toOperationNumber`, on purpose outside `LAM-OP-SCOPE` (which fences ids to
// this operation): here the fence is that the number is an open operation of this turn's importer, in
// this world, and not this one. The model never names an operation id.
import { fail, ok } from "@legajo/shared";
import { openOperationsOf } from "../../channels/whatsapp/routing";
import type { ToolImplementation } from "../common/context";
import type { ToolInput } from "../common/define";
import type { MESSAGING_TOOLS } from "./schema";

type RouteInput = ToolInput<(typeof MESSAGING_TOOLS)["route_to_operation"]>;

export const ROUTE_TOOL = "route_to_operation";
export const ROUTE_REASON = { NOT_OPEN: "NOT_AN_OPEN_OPERATION_OF_IMPORTER", SAME: "ALREADY_THIS_OPERATION" } as const;

export function routeToOperation(): ToolImplementation<RouteInput> {
  return async (ctx) => {
    const { scope, input } = ctx;
    const operations = await openOperationsOf(ctx.connector, { firmId: scope.firmId, importerId: scope.importerId, clockId: scope.clockId });
    const target = operations.find((operation) => operation.operationNumber === input.toOperationNumber);
    if (target === undefined) {
      await ctx.audit({ decision: "DENY", action: "OPERATION_ROUTED", ruleIds: ["LAM-OP-SCOPE"], reason: ROUTE_REASON.NOT_OPEN });
      return fail("NOT_FOUND", "that number is not an open operation of this importer", ROUTE_REASON.NOT_OPEN);
    }
    if (target.operationId === scope.operationId) return fail("INVALID", "the message is already in that operation", ROUTE_REASON.SAME);
    await ctx.audit({ decision: "ALLOW", action: "OPERATION_ROUTED", ruleIds: ["LAM-OP-SCOPE"], detail: { toOperationNumber: target.operationNumber } });
    return ok({ routed: true, operationId: target.operationId, operationNumber: target.operationNumber, note: "The message moves there when this turn ends; that operation's turn answers the importer. Do not answer here." });
  };
}
