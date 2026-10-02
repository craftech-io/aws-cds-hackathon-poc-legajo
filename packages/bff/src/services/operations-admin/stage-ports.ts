// The `ServicePorts` of a Lambda that hosts the direct handlers with every port of the stage (the
// `OperationWorker`, and the console's `Bff` and the `QaDriver` once their routers call them):
//
//   events     the caller's producer of `OperationEvents.fifo` (worker/sink.ts)
//   timers     the one Scheduler client and the dispatcher of due timers (timers/stage.ts)
//   approvals  `request_approval` of the `handoff` target in process, `caller WORKER`, with the fixed
//              summary of copy/ (the firm's decision completed the dossier)
//   deferred   `deferred_send` of the outbound pipeline (outbound/defer.ts), actor `SYSTEM`
//
// Nothing is read at import time: each port builds its client on first use.
import { ToolError } from "@legajo/shared";
import { productionToolDeps } from "../../agent-tools/common/deps";
import { createHandoffTarget } from "../../agent-tools/handoff/index";
import type { Connector } from "../../connector/index";
import { firmEsAR } from "../../copy/es-AR-firm";
import type { Logger } from "../../lib/log";
import { resendDeferred } from "../../outbound/defer";
import type { OutboundDeps } from "../../outbound/deps";
import { eventBridgeScheduler } from "../../timers/scheduler-client";
import { stageDispatcher } from "../../timers/stage";
import type { OperationEventSink } from "../../worker/sink";
import type { ServicePorts } from "./ports";

export interface StageServicePortsInput {
  readonly data: Connector;
  readonly events: OperationEventSink;
  readonly log: Logger;
  /** The pipeline of the stage (outbound/stage.ts `stageOutboundDeps`), built on the first resend. */
  readonly outbound: () => OutboundDeps;
}

export function stageServicePorts(input: StageServicePortsInput): ServicePorts {
  let handoff: ReturnType<typeof createHandoffTarget> | undefined;
  return {
    events: input.events,
    timers: { data: input.data, scheduler: eventBridgeScheduler(), dispatcher: stageDispatcher(input.events), realClock: () => new Date(), log: input.log },
    approvals: {
      async requestApproval(request) {
        handoff ??= createHandoffTarget(productionToolDeps());
        const answer = await handoff.invoke("request_approval", { caller: { kind: "WORKER", firmId: request.firmId, eventId: request.eventId }, operationId: request.operationId, summary: firmEsAR.completedByFirm });
        if (!answer.ok) throw new ToolError(answer.error.code, `request_approval answered ${answer.error.code}`, answer.error.reason);
      },
    },
    deferred: {
      async resend(request) {
        const decided = await resendDeferred(
          input.outbound(),
          { actor: "SYSTEM", correlationId: request.correlationId ?? request.messageId, log: input.log, refs: { operationId: request.operationId, messageId: request.messageId } },
          { operationId: request.operationId, messageId: request.messageId, timerKey: request.timerKey, atSim: request.atSim },
        );
        return { status: decided.status, ...(decided.nextAllowedAt === undefined ? {} : { nextAllowedAt: decided.nextAllowedAt }) };
      },
    },
  };
}
