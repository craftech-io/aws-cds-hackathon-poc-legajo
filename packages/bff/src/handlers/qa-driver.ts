// Lambda entry of the `QaDriver` (`aws-cds-hackathon-poc-legajo-poc-qa-driver`, no URL; its resource
// policy admits only the bootstrap's `qa-runner` role; ADR-0005, docs/architecture.md §14). It is
// invoked directly with `{ action, idempotencyKey, input }` and always answers `{ ok, … }`
// (qa-driver/driver.ts). Linked resources are read through lib/resource.ts (`Resource`, never
// `process.env`); every AWS client carries its deadline and retry budget.
//
// What the driver drives but does not own (world factory, clock, channel entries, SES client, supplier
// simulator, worker, recipient fence, metrics batch) comes in as ports over the modules that own them
// (qa-driver/stage-ports.ts); the SC-26 actions get the mail bucket, `Leads` and the pool
// (qa-driver/aws-signup.ts).
import { connector, tableClient } from "../connector/index";
import { createLogger } from "../lib/log";
import { bucketName, channelMode } from "../lib/resource";
import { subkey } from "../lib/secrets";
import { agentCoreMemoryReader } from "../qa-driver/aws-memory";
import { mocksHealth, platformClient, readerFaultWriter } from "../qa-driver/aws-mocks";
import { cloudWatchAlarmHistory, g1Probe, sqsDlq } from "../qa-driver/aws-queue";
import { stageSignupActionDeps } from "../qa-driver/aws-signup";
import type { QaResponse } from "../qa-driver/contract";
import { type QaDriver, createQaDriver } from "../qa-driver/driver";
import { type MemoryIdentity, buildHandlers } from "../qa-driver/handlers";
import type { QaPorts } from "../qa-driver/ports";
import { stagePorts } from "../qa-driver/stage-ports";
import { browserUpload } from "../qa-driver/upload";
import { s3DocumentUrlSigner } from "../routers/document-url";
import { harnessIdentity } from "../turns/identity";

/** Harness identity of an operation (turns/identity.ts, the worker's and the purge's own). */
export const harnessMemoryIdentity: MemoryIdentity = {
  of(operation) {
    const identity = harnessIdentity(subkey("runtime-session"), operation);
    return { actorId: identity.actorId, sessionId: identity.runtimeSessionId };
  },
};

export function createDefaultQaDriver(ports?: QaPorts): QaDriver {
  const data = connector();
  return createQaDriver({
    data,
    handlers: buildHandlers({
      table: tableClient(),
      ports: ports ?? stagePorts(data),
      platform: platformClient(),
      mocksHealth: mocksHealth(),
      readerFaults: readerFaultWriter(),
      dlq: sqsDlq(),
      alarmHistory: cloudWatchAlarmHistory(),
      guardrailProbe: g1Probe(),
      memory: agentCoreMemoryReader(),
      memoryIdentity: harnessMemoryIdentity,
      upload: browserUpload(),
      console: { documents: s3DocumentUrlSigner({ bucket: () => bucketName("Documents") }), whatsappMode: () => channelMode("whatsapp") },
      signup: stageSignupActionDeps(),
    }),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "qa-driver" } }),
  });
}

let driver: QaDriver | undefined;

export const handler = async (event: unknown): Promise<QaResponse> => {
  driver ??= createDefaultQaDriver();
  return driver(event);
};
