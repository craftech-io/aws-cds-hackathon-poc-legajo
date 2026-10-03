// The console services of the local UI server (packages/bff/src/routers/console-services.ts): the real
// direct handlers, clock module and `create_upload_link` over the in-memory world, with what the stage
// reaches over AWS kept in process. The platform is the platform mock's own app over its memory store
// (operation 4471 and a free number, 4479, for "Nueva operación"); its feeds are published to a recorder.
// There is no worker here: what the handlers enqueue (`OUTBOUND_SEND`, `AGENT_TURN`, timers that fall
// due) and the phone simulator's envelopes are recorded for the specs, and the world factory's reload
// keeps the template's start (the world is the in-memory slice). The simulator's own PDFs go to the S3
// emulator's `media-local` with the real presigned POST. Never part of a Lambda.
import { createDocumentsTarget } from "@legajo/bff/agent-tools/documents/index";
import { documentsImplementations } from "@legajo/bff/agent-tools/documents/handler";
import { simulatedWhatsAppTransport } from "@legajo/bff/channels/whatsapp/simulated-transport";
import type { WhatsAppSnsEvent } from "@legajo/bff/channels/whatsapp/payloads";
import type { MemoryStores } from "@legajo/bff/connector/index";
import { deriveSubkey, emailHash, newPublicToken, phoneHash, ulid } from "@legajo/bff/lib/crypto";
import { createLogger } from "@legajo/bff/lib/log";
import type { PdfPresigner } from "@legajo/bff/public-web/presign";
import { type ConsoleServices, createConsoleServices } from "@legajo/bff/routers/console-services";
import type { ServiceDeps } from "@legajo/bff/services/operations-admin/ports";
import { fakeScheduler } from "@legajo/bff/sim-mail/testing";
import type { OperationQueueEventInput } from "@legajo/bff/worker/events";
import { CORRELATION_HEADER, IDEMPOTENCY_HEADER, platformPaths } from "@legajo/platform-mock/api";
import { PlatformOperation } from "@legajo/platform-mock/schema";
import { call, operationItem, platformFixture } from "@legajo/platform-mock/testing";
import { ToolError } from "@legajo/shared";

/** Master key of the local world's keyed hashes and envelopes (the stage's comes from `SessionTokenKey`). */
const LOCAL_MASTER_KEY = new TextEncoder().encode("legajo-local-ui-server-master-key");

export interface LocalConsoleServices {
  readonly services: ConsoleServices;
  /** What a worker would have received. */
  readonly events: OperationQueueEventInput[];
  readonly envelopes: WhatsAppSnsEvent[];
}

export function createLocalConsoleServices(stores: MemoryStores, now: () => Date, mediaPresigner: PdfPresigner): LocalConsoleServices {
  const log = createLogger({ level: "warn", bindings: { service: "ui-server-services" } });
  const events: OperationQueueEventInput[] = [];
  const envelopes: WhatsAppSnsEvent[] = [];
  const platform = platformFixture({ items: [operationItem(), operationItem({ operationNumber: "4479", eta: "2026-10-30T08:00:00-03:00", documents: { COMMERCIAL_INVOICE: "MISSING", PACKING_LIST: "MISSING", CERTIFICATE_OF_ORIGIN: "MISSING" } })] });
  const realClock = { now: () => Promise.resolve(now()) };
  const media = new Map<string, { readonly sizeBytes: number; readonly contentType: string }>();

  async function feed(path: string, idempotencyKey: string, body: Record<string, unknown>): Promise<unknown> {
    const answer = await call(platform.app, "POST", path, { body, headers: { [IDEMPOTENCY_HEADER]: idempotencyKey, [CORRELATION_HEADER]: idempotencyKey.replaceAll(":", "-") } });
    if (answer.status >= 400) throw new ToolError(answer.status === 404 ? "NOT_FOUND" : answer.status === 409 ? "CONFLICT" : "UNAVAILABLE", `platform mock answered ${answer.status}`);
    return answer.json;
  }

  const deps: ServiceDeps = {
    connector: stores.connector,
    wallClock: now,
    loggerFor: () => log,
    events: { enqueue: async (event: OperationQueueEventInput) => void events.push(event) },
    timers: { data: stores.connector, scheduler: fakeScheduler(), dispatcher: { dispatch: async () => undefined }, realClock: now, log },
    approvals: { requestApproval: async () => undefined },
    deferred: { resend: async () => ({ status: "DEFERRED" }) },
    keys: {
      phoneHash: (phone) => phoneHash(deriveSubkey(LOCAL_MASTER_KEY, "phone-hash"), phone),
      emailHash: (email) => emailHash(deriveSubkey(LOCAL_MASTER_KEY, "email-hash"), email),
      threadKey: () => deriveSubkey(LOCAL_MASTER_KEY, "thread"),
    },
    demoRecipients: () => [],
    quotaTable: stores.client,
    platform: {
      async get(firmId, operationNumber) {
        const answer = await call(platform.app, "GET", platformPaths.operation(firmId, operationNumber));
        if (answer.status === 404) throw new ToolError("NOT_FOUND", "the customs platform has no operation with that number for this firm", "PLATFORM_NOT_FOUND");
        return PlatformOperation.parse(answer.json);
      },
    },
    newId: () => ulid(now().getTime()),
  };

  const documents = createDocumentsTarget(
    { connector: stores.connector, sessionKey: () => deriveSubkey(LOCAL_MASTER_KEY, "session"), wallClock: now, loggerFor: () => log },
    documentsImplementations({
      reader: () => {
        throw new Error("the UI server has no document reader");
      },
      sourceUrl: () => Promise.reject(new Error("the UI server has no document reader")),
      newToken: () => newPublicToken(),
    }),
  );

  const services = createConsoleServices({
    services: deps,
    rebuild: {
      reload: async (input) => ({ startAtSim: (await stores.connector.world.getClock(input.clockId)).startAtSim }),
      purgeMemory: async () => undefined,
    },
    feeds: {
      moveEta: (input) => feed(platformPaths.eta(input.firmId, input.operationNumber), input.idempotencyKey, { newEta: input.newEta, occurredAtSim: input.occurredAtSim }),
      customsStatus: (input) =>
        feed(platformPaths.customsStatus(input.firmId, input.operationNumber), input.idempotencyKey, { status: input.status, ...(input.channel === undefined ? {} : { channel: input.channel }), occurredAtSim: input.occurredAtSim }),
    },
    simulator: {
      phone: () => ({ simEnvelopeKey: deriveSubkey(LOCAL_MASTER_KEY, "sim-envelope"), delivery: { deliver: async (event) => void envelopes.push(event) }, realClock }),
      transport: () =>
        simulatedWhatsAppTransport({
          conversations: stores.connector.conversations,
          templates: stores.connector.reference,
          media: { head: async (key) => media.get(key), digest: () => Promise.reject(new Error("not read in the UI server")), delete: async (key) => void media.delete(key) },
          realClock,
          log,
        }),
      media: {
        presign: (key) => mediaPresigner.presign(key),
        copySeedPdf: async (input) => void media.set(input.key, { sizeBytes: 2048, contentType: "application/pdf" }),
      },
    },
    uploadLinks: { create: (input) => documents.invoke("create_upload_link", { caller: input.caller, operationId: input.operationId, docTypes: [...input.docTypes] }) },
  });
  return { services, events, envelopes };
}
