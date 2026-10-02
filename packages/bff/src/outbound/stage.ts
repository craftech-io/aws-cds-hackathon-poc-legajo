// The outbound pipeline's ports in a Lambda (`ToolMessaging`, the `OperationWorker`, `ToolHandoff`),
// built from what SST links into the function (lib/resource.ts, lib/secrets.ts; never `process.env`):
//
//   data         the DynamoDB connector                                    connector/index.ts
//   email        the single SES client, SYSTEM profile                      Resource.EmailSender*
//   whatsapp     the transport of `ChannelModes.whatsapp`, simulated in a   Resource.ChannelModes,
//                guest world (routes.ts)                                    WabaId, WhatsAppPhoneNumberId
//   guardrail    G2 `ApplyGuardrail` (`source OUTPUT`)                      Resource.GuardrailG2
//   fence        the registry's view of the recipient fence                 SessionTokenKey (`thread`,
//                                                                           `email-hash`), SeedOverrides
//   quotaTable   `Runtime/QUOTA#…` of the guest worlds                      Resource.Runtime
//   arming       `TIMER#DEFERRED_SEND#` and its schedule (timers/)          Resource.Scheduler,
//                                                                           Resource.OperationEvents
//   uploadLinks  `create_upload_link` in process, `caller WORKER`           agent-tools/documents
//
// Nothing is read at import time: each port reads its link or secret when it is first used, so a
// missing link fails the call, not the cold start.
import { ToolError, type ErrorCode } from "@legajo/shared";
import { productionToolDeps } from "../agent-tools/common/deps";
import { createDocumentsTarget } from "../agent-tools/documents/index";
import { stageEmailClient, stageFenceDeps } from "../channels/email/adapter";
import { stageWhatsAppFactories } from "../channels/whatsapp/adapter";
import { connector, tableClient, type Connector } from "../connector/index";
import { timerKeyOf } from "../domain/timers";
import { emailHash, ulid } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { channelMode } from "../lib/resource";
import { subkey, whatsAppConnection } from "../lib/secrets";
import { holidaysReader } from "../policy-audit/facts";
import { eventBridgeScheduler } from "../timers/scheduler-client";
import { armTimer, timerDispatcher } from "../timers/timers";
import { linkedQueueSink } from "../worker/sink";
import type { OutboundDeps, TimerArming, UploadLinks } from "./deps";
import { createBedrockG2, linkedG2Config } from "./grounding";
import { whatsappRoutes } from "./routes";

const realNow = (): Date => new Date();

/** `create_upload_link` as the worker calls it, in process (the template's URL button, docs/architecture-integrations.md §7). */
export function inProcessUploadLinks(): UploadLinks {
  let target: ReturnType<typeof createDocumentsTarget> | undefined;
  return {
    async issue(input) {
      target ??= createDocumentsTarget(productionToolDeps());
      const answer = await target.invoke("create_upload_link", { caller: { kind: "WORKER", firmId: input.firmId }, operationId: input.operationId, docTypes: [...input.docTypes] });
      if (!answer.ok) throw new ToolError(answer.error.code as ErrorCode, `the upload link could not be created: ${answer.error.message}`, answer.error.reason);
      const { token, url } = answer as { token?: unknown; url?: unknown };
      if (typeof token !== "string" || typeof url !== "string") throw new ToolError("UNAVAILABLE", "create_upload_link answered without a link");
      return { token, url };
    },
  };
}

/** `TIMER#DEFERRED_SEND#` through the timers module; a due timer of a running world goes to the queue. */
export function stageTimerArming(data: Connector, log: Logger): TimerArming {
  const deps = {
    data,
    scheduler: eventBridgeScheduler(),
    dispatcher: timerDispatcher({ events: linkedQueueSink(data.world), simReply: () => Promise.reject(new RangeError("a deferred send never arms a SIM_REPLY timer")) }),
    realClock: realNow,
    log,
  };
  return {
    async arm(spec) {
      const armed = await armTimer({ operationId: spec.operationId, clockId: spec.clockId, kind: "DEFERRED_SEND", timerId: spec.timerId, dueAtSim: spec.dueAtSim, reason: spec.reason, payload: spec.payload }, deps);
      return { timerKey: timerKeyOf(armed.timer.kind, armed.timer.timerId) };
    },
  };
}

export interface StageOutboundOptions {
  readonly data?: Connector;
  readonly uploadLinks?: UploadLinks;
  readonly arming?: TimerArming;
}

export function stageOutboundDeps(log: Logger, options: StageOutboundOptions = {}): OutboundDeps {
  const data = options.data ?? connector();
  const factories = stageWhatsAppFactories(log, data);
  return {
    data,
    email: stageEmailClient(log, data),
    whatsapp: whatsappRoutes({
      mode: () => channelMode("whatsapp"),
      simulated: () => factories.simulated(),
      live: () => {
        const connection = whatsAppConnection();
        if (connection === undefined) throw new ToolError("UNAVAILABLE", "live WhatsApp needs its connection (docs/pending.md P-01)");
        return { transport: factories.live(), phoneNumberId: connection.phoneNumberId };
      },
    }),
    guardrail: createBedrockG2(),
    g2Limits: linkedG2Config,
    fence: stageFenceDeps(data),
    quotaTable: tableClient(),
    nonceKey: () => subkey("nonce"),
    emailHash: (address) => emailHash(subkey("email-hash"), address),
    uploadLinks: options.uploadLinks ?? inProcessUploadLinks(),
    arming: options.arming ?? stageTimerArming(data, log),
    holidays: holidaysReader(data),
    wallClock: realNow,
    newId: () => ulid(realNow().getTime()),
  };
}
