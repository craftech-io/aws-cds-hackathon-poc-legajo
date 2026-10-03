// Lambda entry of the `QaDriver` (`aws-cds-hackathon-poc-legajo-poc-qa-driver`, no URL; its resource
// policy admits only the bootstrap's `qa-runner` role; ADR-0005, docs/architecture.md §14). It is
// invoked directly with `{ action, idempotencyKey, input }` and always answers `{ ok, … }`
// (qa-driver/driver.ts). Linked resources are read through lib/resource.ts (`Resource`, never
// `process.env`); every AWS client carries its deadline and retry budget.
//
// The modules the driver drives but does not own (world factory, clock, channel entries, SES client,
// supplier simulator, worker, recipient fence, metrics batch) are ports: the world factory is wired
// (`world.create`/`world.destroy`, qa-driver/worlds-port.ts, Memory passes 2+ handed to `WorldJanitor`)
// and so is the supplier simulator (`supplier.sendNow` invokes `SimMail` synchronously); until each of
// the others is wired with this function, its actions answer UNAVAILABLE / NOT_WIRED (qa-driver/ports.ts).
import { ToolError } from "@legajo/shared";
import { connector, tableClient } from "../connector/index";
import { createLogger } from "../lib/log";
import { bucketName, channelMode } from "../lib/resource";
import { subkey } from "../lib/secrets";
import { agentCoreMemoryReader } from "../qa-driver/aws-memory";
import { mocksHealth, platformClient, readerFaultWriter } from "../qa-driver/aws-mocks";
import { cloudWatchAlarmHistory, g1Probe, sqsDlq } from "../qa-driver/aws-queue";
import type { QaResponse } from "../qa-driver/contract";
import { type QaDriver, createQaDriver } from "../qa-driver/driver";
import { type MemoryIdentity, buildHandlers } from "../qa-driver/handlers";
import { type QaPorts, unwiredPorts } from "../qa-driver/ports";
import { browserUpload } from "../qa-driver/upload";
import { worldFactoryPort } from "../qa-driver/worlds-port";
import { s3DocumentUrlSigner } from "../routers/document-url";
import { lambdaSimMailInvoker } from "../sim-mail/invoke";
import { lambdaAsyncInvoker } from "../signup/invoke";
import { harnessIdentity } from "../turns/identity";
import { type WorldsDeps, stageWorldsDeps } from "../worlds/deps";
import { qaWorldObjectsGrant, s3WorldObjects } from "../worlds/objects";

/** `supplier.sendNow` over `SimMail` (`sim_reply`, mode `SEND_NOW`): a refusal is the step's error. */
function simMailPort(): QaPorts["simMail"] {
  const simMail = lambdaSimMailInvoker();
  return {
    async sendNow(input) {
      const result = await simMail.sendNow({ ...input, docTypes: [...input.docTypes] });
      if (result.status === "REFUSED") throw new ToolError(result.code, `SimMail refused the send: ${result.reason}`, result.reason);
    },
  };
}

/**
 * The world factory with the stage's links, built on first use: objects only under `QaWorldObjects`
 * (`qa/` and the guest-test world's prefix; no upload links, no raw MIME: the buckets' lifecycle takes
 * them), and Memory passes 2+ handed to `WorldJanitor` (`MEMORY_PURGE`, asynchronous).
 */
function stageQaWorlds(): () => WorldsDeps {
  let deps: WorldsDeps | undefined;
  return () => {
    if (deps !== undefined) return deps;
    const invoker = lambdaAsyncInvoker();
    const base = stageWorldsDeps({ log: createLogger({ bindings: { service: "qa-driver-worlds" } }), continuePurge: (target) => invoker.invoke("WorldJanitor", { ...target, kind: "MEMORY_PURGE" }) });
    deps = { ...base, objects: s3WorldObjects({ grant: qaWorldObjectsGrant }), mailPrefixes: () => [] };
    return deps;
  };
}

/** The ports wired in this deployment; the others answer NOT_WIRED until their modules land. */
function stagePorts(): QaPorts {
  const unwired = unwiredPorts();
  return { ...unwired, worlds: worldFactoryPort(stageQaWorlds()), simMail: simMailPort() };
}

/** Harness identity of an operation (turns/identity.ts, the worker's and the purge's own). */
export const harnessMemoryIdentity: MemoryIdentity = {
  of(operation) {
    const identity = harnessIdentity(subkey("runtime-session"), operation);
    return { actorId: identity.actorId, sessionId: identity.runtimeSessionId };
  },
};

export function createDefaultQaDriver(ports: QaPorts = stagePorts()): QaDriver {
  const now = () => new Date();
  const platform = platformClient();
  return createQaDriver({
    data: connector(),
    handlers: buildHandlers({
      table: tableClient(),
      ports,
      platform,
      mocksHealth: mocksHealth(),
      readerFaults: readerFaultWriter(),
      dlq: sqsDlq(),
      alarmHistory: cloudWatchAlarmHistory(),
      guardrailProbe: g1Probe(),
      memory: agentCoreMemoryReader(),
      memoryIdentity: harnessMemoryIdentity,
      upload: browserUpload(),
      console: { documents: s3DocumentUrlSigner({ bucket: () => bucketName("Documents") }), whatsappMode: () => channelMode("whatsapp") },
    }),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "qa-driver" } }),
  });
}

let driver: QaDriver | undefined;

export const handler = async (event: unknown): Promise<QaResponse> => {
  driver ??= createDefaultQaDriver();
  return driver(event);
};
