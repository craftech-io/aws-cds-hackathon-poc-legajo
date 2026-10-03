// The console and the platform of a local world. The console is the real `appRouter` with the console
// services bound to the local stage (routers/console-services.ts): the real direct handlers over the
// stage's ports, the world factory's rebuild, the phone simulator that delivers to `InboundWhatsApp` in
// process, the simulated transport and the real `create_upload_link`. The customs platform is the
// platform mock's own app over the operations the world factory wrote to `Platform`; what it publishes
// on the `Feeds` bus reaches `FeedEvents` as the bus rule would deliver it.
import { randomUUID } from "node:crypto";
import { createTestIssuer, testContextDeps } from "@legajo/bff/auth/testing";
import type { Principal } from "@legajo/bff/auth/principal";
import type { MemoryStores } from "@legajo/bff/connector/index";
import { type ConsoleServices, bindConsoleServices, createConsoleServices } from "@legajo/bff/routers/console-services";
import { createConsoleCaller } from "@legajo/bff/routers/index";
import { serverContext } from "@legajo/bff/routers/trpc";
import type { PhoneSimulatorDeps } from "@legajo/bff/channels/whatsapp/simulator";
import type { WorldsDeps } from "@legajo/bff/worlds/deps";
import { worldRebuild } from "@legajo/bff/worlds/rebuild";
import { CORRELATION_HEADER, IDEMPOTENCY_HEADER, platformPaths } from "@legajo/platform-mock/api";
import { PlatformOperation, PlatformOperationItem } from "@legajo/platform-mock/schema";
import type { PlatformFeedEvent } from "@legajo/platform-mock/events";
import { call, platformFixture, type PlatformFixture } from "@legajo/platform-mock/testing";
import { ToolError, seedKeys } from "@legajo/shared";
import type { SeedBucketObjects } from "../seed-world";
import { LOCAL_BUCKETS, type StageContext } from "./context";

export type ConsoleCaller = ReturnType<typeof createConsoleCaller>;

export interface LocalPlatform {
  readonly fixture: PlatformFixture;
  /** Events the platform published, in order (each one was handed to `FeedEvents`). */
  readonly published: PlatformFeedEvent[];
  get(firmId: string, operationNumber: string): Promise<PlatformOperation>;
  /** Takes the `Platform` rows the world factory wrote after the platform started (new worlds); every call does it first. */
  sync(): void;
  feed(path: string, idempotencyKey: string, body: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** The EventBridge envelope a target of the `Feeds` rule receives. */
export function busEnvelope(event: PlatformFeedEvent, at: Date): unknown {
  return { version: "0", id: randomUUID(), source: event.source, "detail-type": event.detailType, account: "000000000000", time: at.toISOString(), region: "us-east-1", resources: [], detail: event.detail };
}

export function createLocalPlatform(stores: MemoryStores, now: () => Date, deliver: (envelope: unknown) => Promise<void>): LocalPlatform {
  const rowsOf = () => stores.client.dump("Platform").map((row) => PlatformOperationItem.parse(row));
  const items = rowsOf();
  const known = new Set(items.map((item) => item.PK));
  const published: PlatformFeedEvent[] = [];
  const fixture = platformFixture({
    items,
    deps: { now },
    wrapPublisher: (recording) => ({
      async publish(event) {
        await recording.publish(event);
        published.push(event);
        await deliver(busEnvelope(event, now()));
      },
    }),
  });
  const sync = () => {
    for (const item of rowsOf()) {
      if (known.has(item.PK)) continue;
      known.add(item.PK);
      fixture.store.putOperation(item);
    }
  };
  return {
    fixture,
    published,
    sync,
    async get(firmId, operationNumber) {
      sync();
      const answer = await call(fixture.app, "GET", platformPaths.operation(firmId, operationNumber));
      if (answer.status === 404) throw new ToolError("NOT_FOUND", "the customs platform has no operation with that number for this firm", "PLATFORM_NOT_FOUND");
      return PlatformOperation.parse(answer.json);
    },
    async feed(path, idempotencyKey, body) {
      sync();
      const answer = await call(fixture.app, "POST", path, { body, headers: { [IDEMPOTENCY_HEADER]: idempotencyKey, [CORRELATION_HEADER]: idempotencyKey.replaceAll(":", "-") } });
      if (answer.status >= 400) throw new ToolError(answer.status === 404 ? "NOT_FOUND" : answer.status === 409 ? "CONFLICT" : "UNAVAILABLE", `platform mock answered ${answer.status}`);
      return answer.json;
    },
  };
}

export interface LocalConsole {
  readonly services: ConsoleServices;
  caller(principal: Principal): ConsoleCaller;
}

export function createLocalConsole(stage: StageContext, worlds: WorldsDeps, platform: LocalPlatform, phone: () => PhoneSimulatorDeps, seed: SeedBucketObjects): LocalConsole {
  const services = createConsoleServices({
    services: stage.services,
    rebuild: worldRebuild(worlds),
    feeds: {
      moveEta: (input) => platform.feed(platformPaths.eta(input.firmId, input.operationNumber), input.idempotencyKey, { newEta: input.newEta, occurredAtSim: input.occurredAtSim }),
      customsStatus: (input) =>
        platform.feed(platformPaths.customsStatus(input.firmId, input.operationNumber), input.idempotencyKey, { status: input.status, ...(input.channel === undefined ? {} : { channel: input.channel }), occurredAtSim: input.occurredAtSim }),
    },
    simulator: {
      phone,
      transport: () => stage.transport,
      media: {
        presign: async (key) => ({ url: `https://${LOCAL_BUCKETS.media}.s3.us-east-1.amazonaws.com`, fields: { key, "Content-Type": "application/pdf" } }),
        async copySeedPdf(input) {
          const body = seed.get(seedKeys.pdf(input.templateOperation, input.docType, input.version));
          if (body === undefined) throw new ToolError("NOT_FOUND", "that PDF is not in the seed");
          stage.aws.objects.put({ bucket: LOCAL_BUCKETS.media, key: input.key, body, contentType: "application/pdf" });
        },
      },
    },
    uploadLinks: { create: (input) => stage.targets.documents.invoke("create_upload_link", { caller: input.caller, operationId: input.operationId, docTypes: [...input.docTypes] }) },
  });
  const deps = bindConsoleServices(testContextDeps({ verifier: createTestIssuer({ now: stage.now }).verifier(), stores: stage.stores, now: stage.now }), services);
  return { services, caller: (principal) => createConsoleCaller(serverContext({ principal, deps })) };
}
