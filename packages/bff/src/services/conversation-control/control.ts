// `take_conversation` and `release_conversation` (docs/tool-catalog.md; FL-067, FL-069, FL-070): who
// talks to the importer of an operation. While the control is `BROKER` the agent's sends are denied
// (`LAM-CONTROL`) and inbound messages wait for the firm; releasing it hands the operation back to the
// agent with an `AGENT_TURN(BROKER_RELEASED)` (a new id: a console action has no natural key), whose
// envelope lists what the firm wrote so the agent never repeats it.
//
// Each change is dated at the world's simulated now in `controlHistory` (what `PolicyAudit` rebuilds),
// audited (`ACTION TAKEOVER` / `RELEASE`) and, for a take, counted as a human action. Asking for the
// control the operation already has changes nothing.
import { ConversationControlInput } from "@legajo/shared";
import { channelEvent } from "../../channels/adapter";
import type { Operation } from "../../domain/operations";
import { type DirectContext, createDirectHandler } from "../operations-admin/handler-kit";
import { countHumanAction } from "../operations-admin/human-actions";
import type { ServiceDeps } from "../operations-admin/ports";
import { fencedOperation } from "../operations-admin/world-scope";
import { newConsoleEventId } from "./outbound-send";

type ControlTarget = Operation["control"];

async function changeControl(ctx: DirectContext<{ readonly operationId: string }>, to: ControlTarget): Promise<{ readonly operation: Operation; readonly atSim: string; readonly changed: boolean }> {
  const operation = await fencedOperation(ctx, ctx.input.operationId);
  const { atSim } = await ctx.world(operation.clockId);
  if (operation.control === to) return { operation, atSim, changed: false };
  const changed = await ctx.connector.operations.setControl({ operationId: operation.operationId, control: to, atSim, atReal: ctx.now().toISOString(), by: ctx.actor, expectedVersion: operation.version });
  await ctx.audit({
    firmId: operation.firmId,
    decision: "ACTION",
    action: to === "BROKER" ? "TAKEOVER" : "RELEASE",
    clockId: operation.clockId,
    operationId: operation.operationId,
    atSim,
    ...(ctx.caller.brokerId === undefined ? {} : { refs: { brokerId: ctx.caller.brokerId } }),
  });
  return { operation: changed, atSim, changed: true };
}

export function takeConversationHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "take_conversation",
      input: ConversationControlInput,
      callers: ["CONSOLE", "QA"],
      async run(ctx) {
        const { operation, changed } = await changeControl(ctx, "BROKER");
        if (changed) await countHumanAction(ctx, operation, "TAKE");
        return { operationId: operation.operationId, control: operation.control, changed };
      },
    },
    deps,
  );
}

export function releaseConversationHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "release_conversation",
      input: ConversationControlInput,
      callers: ["CONSOLE", "QA"],
      async run(ctx) {
        const { operation, atSim, changed } = await changeControl(ctx, "AGENT");
        if (changed) {
          await deps.events.enqueue(
            channelEvent({
              type: "AGENT_TURN",
              eventId: newConsoleEventId(ctx.now().getTime()),
              operationId: operation.operationId,
              clockId: operation.clockId,
              firmId: operation.firmId,
              eventAtSim: atSim,
              correlationId: ctx.correlationId,
              trigger: "BROKER_RELEASED",
            }),
          );
        }
        return { operationId: operation.operationId, control: operation.control, changed };
      },
    },
    deps,
  );
}
