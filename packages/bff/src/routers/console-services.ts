// What the console's mutations run on besides `ctx.deps` (docs/tool-catalog.md "Procedimientos de la
// consola"; docs/build-plan.md WP-33): the direct handlers of `services/` over the stage's ports, the
// clock module's dependencies, the world factory's part of a reset, the platform's two feeds, the phone
// simulator and the upload-link tool. Each router reaches them through `consoleServicesOf(ctx.deps)`:
//
//   services     `stageServiceDeps(stageServicePorts(…))`: the handlers' dependencies; its `timers` are
//                the clock module's (`ClockDeps`) and its `quotaTable` is where guest quotas count
//   handlers     `directHandlers(services)`, called with the caller the principal stands for
//                (`CONSOLE`, or `QA` for the `QaDriver`'s server-built principal)
//   rebuild      `WorldRebuild` of the world factory (WP-31): reload from the template, purge Memory
//   feeds        `POST …/eta` and `…/customs-status` of `PlatformMock` (SigV4), which publish to `Feeds`
//   simulator    the signed envelope to `InboundWhatsApp`, "marcar leído" on the simulated transport,
//                the presigned POST to `Media/sim/…` and the copy of a synthetic PDF from `Seed`
//   uploadLinks  `create_upload_link` of the `documents` target in process, caller `CONSOLE`
//
// The Lambda builds them once per container on first use (nothing is read at import time). Tests, the
// local UI server and the local flows bind their own to their `ContextDeps` with `bindConsoleServices`.
import { CopyObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type Caller, type DocType, seedKeys } from "@legajo/shared";
import type { QuotaKind } from "@legajo/shared/guest-limits";
import { productionToolDeps } from "../agent-tools/common/deps";
import type { ToolResponse } from "../agent-tools/common/context";
import { createDocumentsTarget } from "../agent-tools/documents/index";
import { QA_PRINCIPAL, type Principal } from "../auth/principal";
import { stageMediaStore, stagePhoneSimulator } from "../channels/whatsapp/adapter";
import { type SimulatedWhatsAppTransport, simulatedWhatsAppTransport } from "../channels/whatsapp/simulated-transport";
import type { PhoneSimulatorDeps } from "../channels/whatsapp/simulator";
import type { ResetDeps, WorldRebuild } from "../clock/reset";
import { connector } from "../connector/index";
import { awsClientConfig } from "../lib/clients";
import { systemClock } from "../lib/clock";
import { type Logger, createLogger } from "../lib/log";
import { bucketName } from "../lib/resource";
import { stageOutboundDeps } from "../outbound/stage";
import { type PresignedPost, STAGE_REGION, s3PdfPresigner } from "../public-web/presign";
import { type DirectHandlerName, type DirectResponse, unwrapDirect } from "../services/operations-admin/handler-kit";
import { linkedPlatformClient } from "../services/operations-admin/platform";
import { type DirectHandlers, directHandlers } from "../services/operations-admin/handlers";
import { type ServiceDeps, stageServiceDeps } from "../services/operations-admin/ports";
import { stageServicePorts } from "../services/operations-admin/stage-ports";
import { type AsyncInvoker, lambdaAsyncInvoker } from "../signup/invoke";
import { linkedQueueSink } from "../worker/sink";
import { stageWorldsDeps } from "../worlds/deps";
import { consumeQuota } from "../worlds/guest-quotas";
import { worldRebuild } from "../worlds/rebuild";
import type { ContextDeps } from "./deps";
import type { FirmContext } from "./trpc";

/** The platform's feeds the console injects ("Mover ETA", "Emitir estado de despacho"). */
export interface PlatformFeeds {
  moveEta(input: { readonly firmId: string; readonly operationNumber: string; readonly newEta: string; readonly occurredAtSim: string; readonly idempotencyKey: string }): Promise<unknown>;
  customsStatus(input: { readonly firmId: string; readonly operationNumber: string; readonly status: string; readonly channel?: string; readonly occurredAtSim: string; readonly idempotencyKey: string }): Promise<unknown>;
}

/** `Media/sim/…` as the phone simulator writes it. */
export interface SimulatorMedia {
  /** Presigned POST of one PDF to exactly `key` (the conditions of every upload, public-web/presign.ts). */
  presign(key: string): Promise<PresignedPost>;
  /** A synthetic PDF of the world's template (`Seed/pdfs/…`) copied to `key`. */
  copySeedPdf(input: { readonly templateOperation: string; readonly docType: DocType; readonly version: number; readonly key: string }): Promise<void>;
}

export interface SimulatorPorts {
  readonly phone: () => PhoneSimulatorDeps;
  readonly transport: () => SimulatedWhatsAppTransport;
  readonly media: SimulatorMedia;
}

export interface UploadLinkIssuer {
  /** `create_upload_link` for the operation's importer, as the console asks for it. */
  create(input: { readonly caller: Caller; readonly operationId: string; readonly docTypes: readonly DocType[] }): Promise<ToolResponse>;
}

export interface ConsoleServices {
  readonly services: ServiceDeps;
  readonly handlers: DirectHandlers;
  readonly rebuild: WorldRebuild;
  readonly feeds: PlatformFeeds;
  readonly simulator: SimulatorPorts;
  readonly uploadLinks: UploadLinkIssuer;
}

export type ConsoleServiceParts = Omit<ConsoleServices, "handlers">;

/** The services over explicit parts: the handlers are always the real ones over `parts.services`. */
export function createConsoleServices(parts: ConsoleServiceParts): ConsoleServices {
  return { ...parts, handlers: directHandlers(parts.services) };
}

/**
 * The world factory of the stage (worlds/rebuild.ts), built on the first reset: the Bff runs pass 1 of
 * the Memory purge in the request and hands the rest to `WorldJanitor` (`MEMORY_PURGE`, asynchronous).
 */
function stageRebuild(log: Logger): WorldRebuild {
  let rebuild: WorldRebuild | undefined;
  let invoker: AsyncInvoker | undefined;
  const factory = (): WorldRebuild =>
    (rebuild ??= worldRebuild(stageWorldsDeps({ log, continuePurge: (target) => (invoker ??= lambdaAsyncInvoker()).invoke("WorldJanitor", { ...target, kind: "MEMORY_PURGE" }) })));
  return { reload: (input) => factory().reload(input), purgeMemory: (input) => factory().purgeMemory(input) };
}

const S3_TIMEOUTS = { requestTimeoutMs: 10_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

/** Presign and copy of the stage's `Media` and `Seed` buckets, clients built on first use. */
export function s3SimulatorMedia(options: { readonly media: () => string; readonly seed: () => string; readonly client?: S3Client }): SimulatorMedia {
  let client = options.client;
  let presigner: ReturnType<typeof s3PdfPresigner> | undefined;
  const s3 = (): S3Client => (client ??= new S3Client({ region: STAGE_REGION, ...awsClientConfig(S3_TIMEOUTS) }));
  return {
    presign: (key) => (presigner ??= s3PdfPresigner({ bucket: options.media(), client: s3() })).presign(key),
    async copySeedPdf(input) {
      const source = seedKeys.pdf(input.templateOperation, input.docType, input.version);
      await s3().send(new CopyObjectCommand({ Bucket: options.media(), Key: input.key, CopySource: `${options.seed()}/${source}`, ContentType: "application/pdf", MetadataDirective: "REPLACE" }));
    },
  };
}

function stageConsoleServices(): ConsoleServices {
  const data = connector();
  const log = createLogger({ bindings: { service: "bff-services" } });
  let outbound: ReturnType<typeof stageOutboundDeps> | undefined;
  const services = stageServiceDeps(stageServicePorts({ data, events: linkedQueueSink(data.world), log, outbound: () => (outbound ??= stageOutboundDeps(log, { data })) }));
  const platform = linkedPlatformClient();
  let documents: ReturnType<typeof createDocumentsTarget> | undefined;
  let transport: SimulatedWhatsAppTransport | undefined;
  return createConsoleServices({
    services,
    rebuild: stageRebuild(log),
    feeds: { moveEta: (input) => platform.moveEta(input), customsStatus: (input) => platform.customsStatus(input) },
    simulator: {
      phone: stagePhoneSimulator,
      transport: () => (transport ??= simulatedWhatsAppTransport({ conversations: data.conversations, templates: data.reference, media: stageMediaStore(), realClock: systemClock, log })),
      media: s3SimulatorMedia({ media: () => bucketName("Media"), seed: () => bucketName("Seed") }),
    },
    uploadLinks: {
      create: (input) => (documents ??= createDocumentsTarget(productionToolDeps())).invoke("create_upload_link", { caller: input.caller, operationId: input.operationId, docTypes: [...input.docTypes] }),
    },
  });
}

const bound = new WeakMap<ContextDeps, ConsoleServices>();
let stage: ConsoleServices | undefined;

/** The services every router of a request with these dependencies uses (tests, the UI server, the local flows). */
export function bindConsoleServices(deps: ContextDeps, services: ConsoleServices): ContextDeps {
  bound.set(deps, services);
  return deps;
}

/** The services bound to `deps`, else the stage's (built once per container). */
export function consoleServicesOf(deps: ContextDeps): ConsoleServices {
  return bound.get(deps) ?? (stage ??= stageConsoleServices());
}

// ---- Calls -------------------------------------------------------------------------------------------

/** The `QaDriver`'s principal is built on the server only (auth/principal.ts `qaPrincipal`): a Cognito `sub` is a UUID. */
export function isQaPrincipal(principal: Principal): boolean {
  return principal.sub === QA_PRINCIPAL.sub && principal.firmId === QA_PRINCIPAL.firmId;
}

/** Who calls a direct handler: the principal's firm, role and broker, never anything of the input. */
export function callerOf(principal: Principal): Caller {
  return {
    kind: isQaPrincipal(principal) ? "QA" : "CONSOLE",
    firmId: principal.firmId,
    role: principal.role,
    ...(principal.brokerId === undefined ? {} : { brokerId: principal.brokerId }),
  };
}

type Payload<R extends object> = Omit<R, "ok">;

/** The payload of a successful handler call (without `ok`), or its refusal rethrown for trpc.ts to map. */
export function payloadOf<R extends object>(response: DirectResponse<R>): Payload<R> {
  const { ok: _ok, ...payload } = unwrapDirect(response) as R & { ok: true };
  return payload as Payload<R>;
}

/** Runs one direct handler of `services/` as the request's principal. */
export async function runDirect(ctx: FirmContext, name: DirectHandlerName, input: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const handler = consoleServicesOf(ctx.deps).handlers[name];
  return payloadOf(await handler({ ...input, caller: callerOf(ctx.principal) }, { correlationId: ctx.correlationId }));
}

/** One unit of a guest world's quota (ADR-0015 §4): `QUOTA_EXCEEDED` past its limit; no-op outside `GUEST#*`. */
export async function consumeConsoleQuota(ctx: Pick<FirmContext, "deps" | "log">, clockId: string, kind: Exclude<QuotaKind, "WORLD_PREPARATIONS">): Promise<void> {
  await consumeQuota({ client: consoleServicesOf(ctx.deps).services.quotaTable, now: ctx.deps.wallClock, log: ctx.log }, clockId, kind);
}

/** What `resetWorld` needs: the clock's dependencies, the tables, the address hash and the world factory. */
export function resetDepsOf(services: ConsoleServices): ResetDeps {
  const { services: deps } = services;
  return { ...deps.timers, data: deps.connector, client: deps.quotaTable, addressHash: deps.keys.emailHash, rebuild: services.rebuild };
}
