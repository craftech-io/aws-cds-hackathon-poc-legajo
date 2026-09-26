// Lambda entry of the `QaDriver` (`aws-cds-hackathon-poc-legajo-poc-qa-driver`, no URL; its resource
// policy admits only the bootstrap's `qa-runner` role; ADR-0005, docs/architecture.md §14). It is
// invoked directly with `{ action, idempotencyKey, input }` and always answers `{ ok, … }`
// (qa-driver/driver.ts). Linked resources are read through lib/resource.ts (`Resource`, never
// `process.env`); every AWS client carries its deadline and retry budget.
//
// The modules the driver drives but does not own (world factory, clock, channel entries, SES client,
// supplier simulator, worker, recipient fence, metrics batch) are ports: until each one is deployed
// with this function, its actions answer UNAVAILABLE / NOT_WIRED (qa-driver/ports.ts).
import { connector, tableClient } from "../connector/index";
import { runtimeSessionId } from "../lib/crypto";
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
import { s3DocumentUrlSigner } from "../routers/document-url";

/** Harness identity of an operation: `<importerId>-e<worldEpoch>` and the keyed session id (docs/architecture.md §9.1). */
export const harnessMemoryIdentity: MemoryIdentity = {
  of(operation) {
    return {
      actorId: `${operation.importerId}-e${operation.worldEpoch}`,
      sessionId: runtimeSessionId(subkey("runtime-session"), { operationId: operation.operationId, clockId: operation.clockId, worldEpoch: operation.worldEpoch, sessionEpoch: operation.sessionEpoch }),
    };
  },
};

export function createDefaultQaDriver(ports: QaPorts = unwiredPorts()): QaDriver {
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
