// Test kit of the console's mutations: the handlers' world of services/operations-admin/testing.ts
// (`firm-delta` with operation 4471 and its parties, `firm-norte`, `firm-qa` and, when asked, the reserved
// guest firm `firm-guest-01`, paused at Wed 14/10 10:30; the real timers over an in-memory Scheduler; a
// sink that records `OperationEvents.fifo`) behind the real `appRouter`, with the console services bound
// to it: the real direct handlers, the real `create_upload_link`, the real simulated WhatsApp transport,
// and recorded fakes where the stage reaches AWS (the platform's feeds, the envelope to `InboundWhatsApp`,
// `Media` and `Seed`, the world factory's reload). Nothing here ships in a Lambda.
import type { DocType } from "@legajo/shared";
import { QuotaExceededError } from "@legajo/shared/errors";
import { GUEST_QUOTAS, type QuotaKind } from "@legajo/shared/guest-limits";
import { createDocumentsTarget } from "../agent-tools/documents/index";
import { documentsImplementations } from "../agent-tools/documents/handler";
import type { Principal } from "../auth/principal";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import { simulatedWhatsAppTransport } from "../channels/whatsapp/simulated-transport";
import type { WhatsAppSnsEvent } from "../channels/whatsapp/payloads";
import type { WorldRebuild } from "../clock/reset";
import { createLogger } from "../lib/log";
import { type ServiceWorld, type ServiceWorldOptions, platformRow, serviceWorld } from "../services/operations-admin/testing";
import { consumeQuota } from "../worlds/guest-quotas";
import { type ConsoleServices, bindConsoleServices, createConsoleServices } from "./console-services";
import type { ContextDeps } from "./deps";
import { createConsoleCaller } from "./index";
import { GUEST_FIRM, SUBS, principalOf } from "./testing";
import { serverContext } from "./trpc";

export const GUEST = principalOf(GUEST_FIRM, "GUEST", SUBS.guest, "brk-guest-01");
export const GUEST_CLOCK = `GUEST#${GUEST_FIRM}`;

export interface FeedCall {
  readonly kind: "ETA" | "STATUS";
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ConsoleServiceWorld extends ServiceWorld {
  readonly contextDeps: ContextDeps;
  readonly services: ConsoleServices;
  readonly feeds: FeedCall[];
  /** Envelopes the phone simulator handed to `InboundWhatsApp`. */
  readonly envelopes: WhatsAppSnsEvent[];
  readonly copies: Array<{ readonly templateOperation: string; readonly docType: DocType; readonly version: number; readonly key: string }>;
  readonly presigned: string[];
  readonly reloads: Array<Parameters<WorldRebuild["reload"]>[0]>;
  readonly purges: Array<Parameters<WorldRebuild["purgeMemory"]>[0]>;
  /** Objects "in" `Media` (`head` of the simulated transport). */
  readonly media: Map<string, { readonly sizeBytes: number; readonly contentType: string }>;
  caller(principal: Principal): ReturnType<typeof createConsoleCaller>;
  /** Spends what is left of the tightest window of a guest world's quota, so its next unit is refused. */
  exhaust(clockId: string, kind: Exclude<QuotaKind, "WORLD_PREPARATIONS">): Promise<void>;
}

export interface ConsoleServiceWorldOptions extends ServiceWorldOptions {
  readonly whatsappMode?: "simulated" | "live";
}

const SIM_ENVELOPE_KEY = new TextEncoder().encode("legajo-console-tests-sim-envelope");

export async function consoleServiceWorld(options: ConsoleServiceWorldOptions = {}): Promise<ConsoleServiceWorld> {
  const world = await serviceWorld(options);
  const { deps } = world;
  const feeds: FeedCall[] = [];
  const envelopes: WhatsAppSnsEvent[] = [];
  const copies: ConsoleServiceWorld["copies"] = [];
  const presigned: string[] = [];
  const reloads: ConsoleServiceWorld["reloads"] = [];
  const purges: ConsoleServiceWorld["purges"] = [];
  const media = new Map<string, { readonly sizeBytes: number; readonly contentType: string }>();
  const log = createLogger({ level: "error" });
  const realClock = { now: () => Promise.resolve(deps.wallClock()) };
  let tokens = 0;

  const services = createConsoleServices({
    services: deps,
    rebuild: {
      reload: async (input) => {
        reloads.push(input);
        return { startAtSim: (await deps.connector.world.getClock(input.clockId)).startAtSim };
      },
      purgeMemory: async (input) => void purges.push(input),
    },
    feeds: {
      moveEta: async (input) => void feeds.push({ kind: "ETA", input }),
      customsStatus: async (input) => void feeds.push({ kind: "STATUS", input }),
    },
    simulator: {
      phone: () => ({ simEnvelopeKey: SIM_ENVELOPE_KEY, delivery: { deliver: async (event) => void envelopes.push(event) }, realClock }),
      transport: () =>
        simulatedWhatsAppTransport({
          conversations: deps.connector.conversations,
          templates: deps.connector.reference,
          media: { head: async (key) => media.get(key), digest: () => Promise.reject(new Error("not read here")), delete: async (key) => void media.delete(key) },
          realClock,
          log,
        }),
      media: {
        presign: async (key) => {
          presigned.push(key);
          return { url: "https://media-local.s3.us-east-1.amazonaws.com", fields: { key, "Content-Type": "application/pdf" } };
        },
        copySeedPdf: async (input) => {
          copies.push(input);
          media.set(input.key, { sizeBytes: 2048, contentType: "application/pdf" });
        },
      },
    },
    uploadLinks: {
      create: (input) => {
        const target = createDocumentsTarget(
          { connector: deps.connector, sessionKey: () => new Uint8Array(32), wallClock: deps.wallClock, loggerFor: () => log },
          documentsImplementations({ reader: () => { throw new Error("no reader here"); }, sourceUrl: () => Promise.reject(new Error("no reader here")), newToken: () => `tok${String((tokens += 1)).padStart(40, "0")}` }),
        );
        return target.invoke("create_upload_link", { caller: input.caller, operationId: input.operationId, docTypes: [...input.docTypes] });
      },
    },
  });

  const contextDeps = bindConsoleServices(testContextDeps({ verifier: createTestIssuer().verifier(), stores: world.stores, now: deps.wallClock, whatsappMode: options.whatsappMode ?? "simulated", lines: world.lines }), services);

  return {
    ...world,
    contextDeps,
    services,
    feeds,
    envelopes,
    copies,
    presigned,
    reloads,
    purges,
    media,
    caller: (principal) => createConsoleCaller(serverContext({ principal, deps: contextDeps })),
    async exhaust(clockId, kind) {
      const tightest = Math.min(...GUEST_QUOTAS[kind].map((window) => window.limit));
      for (let unit = 0; unit < tightest; unit += 1) {
        try {
          await consumeQuota({ client: deps.quotaTable, now: deps.wallClock, log }, clockId, kind);
        } catch (error) {
          if (error instanceof QuotaExceededError) return;
          throw error;
        }
      }
    },
  };
}

/** What `guestOperation` registered in the guest world, through the guest's own console. */
export interface GuestOperation {
  readonly importerId: string;
  readonly supplierId: string;
  readonly operationId: string;
}

/**
 * Operation 4471 of the guest world as a guest builds it: an importer with a phone of its slot's block, a
 * supplier with a simulated mailbox, the platform's row and "Nueva operación".
 */
export async function guestOperation(world: ConsoleServiceWorld): Promise<GuestOperation> {
  const guest = world.caller(GUEST);
  const { importer } = (await guest.registry.importers.upsert({ name: "Litoral Envases SA", contactName: "Rocío Paz", contactFirstName: "Rocío", phoneE164: "+5491155510150", language: "es" })) as { importer: { importerId: string } };
  const { supplier } = (await guest.registry.suppliers.upsert({ name: "Harborline Packaging Ltd.", country: "GB", timezone: "Europe/London", language: "en", contacts: ["ventas-harborline-g01@sim.legajo.demo.craftech.io"] })) as {
    supplier: { supplierId: string };
  };
  world.platform.set(`${GUEST_FIRM}#4471`, platformRow(GUEST_FIRM, "4471", { importerId: importer.importerId, supplierId: supplier.supplierId }));
  const created = (await guest.operations.create({ operationNumber: "4471" })) as { operationId: string };
  return { importerId: importer.importerId, supplierId: supplier.supplierId, operationId: created.operationId };
}
