// Handlers of the platform mock's routes (docs/architecture-integrations.md §6). The two POST routes
// share one change procedure: read the operation, answer a retry with the event its key already
// produced, otherwise plan the patch and the event, commit both atomically on the row's version and
// publish. A publish that fails after the commit answers 503; the retry with the same key finds the
// stored event and publishes it again with the same `eventId`, which `FeedEvents` deduplicates.
import { ConnectorError, DispatchStatus, FirmId, OperationNumber, sha256Hex } from "@legajo/shared";
import { CustomsStatusRequest, EtaChangeRequest, IDEMPOTENCY_HEADER, IdempotencyKey, type PlatformEventResponse } from "./api";
import { carrierEtaChanged, customsStatusChanged, type PlatformEventId, type PlatformFeedEvent } from "./events";
import { PlatformHttpError, conflict, headerValue, jsonBody, jsonResponse, parseOrInvalid, singleQueryValue, type PlatformRequest, type PlatformResponse } from "./http";
import type { PlatformLogFields, PlatformLogSink } from "./log";
import type { PlatformEventPublisher } from "./publisher";
import { instantMs, toPlatformOperation, type CustomsState, type PlatformOperationItem } from "./schema";
import { toPlatformEventItem, type PlatformEventItem, type PlatformOperationPatch, type PlatformStore } from "./store";

export interface PlatformAppDeps {
  readonly store: PlatformStore;
  readonly publisher: PlatformEventPublisher;
  /** Real time of the platform: row times, order of the event log and the time part of event ids. */
  readonly now: () => Date;
  /** Defaults to `evt_<ULID>` at `now()`. */
  readonly newEventId?: () => PlatformEventId;
  /** Defaults to one JSON line on stdout. */
  readonly log?: PlatformLogSink;
}

export type ResolvedDeps = Required<PlatformAppDeps>;

export interface RouteContext {
  readonly deps: ResolvedDeps;
  readonly request: PlatformRequest;
  readonly query: URLSearchParams;
  /** Name of the matched route, part of the idempotency hash. */
  readonly route: string;
  /** Raw `{operationNumber}` of the path, validated by the handler. */
  readonly pathNumber: string | undefined;
  /** Adds validated values to the request's log line. */
  readonly note: (fields: PlatformLogFields) => void;
}

interface OperationScope {
  readonly firmId: string;
  readonly operationNumber: string;
}

interface ChangePlan {
  readonly patch: PlatformOperationPatch;
  readonly event: PlatformFeedEvent;
}

function operationScope(ctx: RouteContext): OperationScope {
  const operationNumber = parseOrInvalid(OperationNumber, ctx.pathNumber, "operation number");
  const firmId = parseOrInvalid(FirmId, singleQueryValue(ctx.query, "firm"), "firm");
  ctx.note({ firmId, operationNumber });
  return { firmId, operationNumber };
}

async function requireOperation(ctx: RouteContext, scope: OperationScope): Promise<PlatformOperationItem> {
  const operation = await ctx.deps.store.getOperation(scope.firmId, scope.operationNumber);
  if (operation === undefined) throw new PlatformHttpError("NOT_FOUND", "no operation with this number in this firm");
  return operation;
}

/** JSON with sorted keys and without undefined members, so the same request always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, member]) => member !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function replay(ctx: RouteContext, earlier: PlatformEventItem, requestHash: string): Promise<PlatformResponse> {
  if (earlier.requestHash !== requestHash) throw conflict("IDEMPOTENCY_KEY_REUSED", "this Idempotency-Key was used for a different request");
  await ctx.deps.publisher.publish(earlier.event);
  ctx.note({ eventId: earlier.eventId, replayed: true });
  const body: PlatformEventResponse = { event: earlier.event, replayed: true };
  return jsonResponse(200, body);
}

async function change(ctx: RouteContext, scope: OperationScope, request: unknown, plan: (operation: PlatformOperationItem, eventId: PlatformEventId) => ChangePlan): Promise<PlatformResponse> {
  const { store, publisher } = ctx.deps;
  const idempotencyKey = parseOrInvalid(IdempotencyKey, headerValue(ctx.request, IDEMPOTENCY_HEADER), "Idempotency-Key header");
  const requestHash = await sha256Hex(canonicalJson({ route: ctx.route, ...scope, request }));
  const operation = await requireOperation(ctx, scope);

  const earlier = await store.findEvent(scope.firmId, scope.operationNumber, idempotencyKey);
  if (earlier !== undefined) return replay(ctx, earlier, requestHash);

  const now = ctx.deps.now();
  const { patch, event } = plan(operation, ctx.deps.newEventId());
  const eventItem = toPlatformEventItem(operation, event, { idempotencyKey, requestHash, now });
  try {
    await store.commit({ operation, patch, eventItem, now });
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    // A concurrent retry of this same request may have won the race: answer with its event.
    const winner = await store.findEvent(scope.firmId, scope.operationNumber, idempotencyKey);
    if (winner !== undefined) return replay(ctx, winner, requestHash);
    throw error;
  }
  await publisher.publish(event);
  ctx.note({ eventId: event.detail.eventId, replayed: false });
  const body: PlatformEventResponse = { event, replayed: false };
  return jsonResponse(200, body);
}

// ---- Routes --------------------------------------------------------------------------------------

export async function healthRoute(): Promise<PlatformResponse> {
  return jsonResponse(200, { status: "ok" });
}

/** `GET /v1/operations/{n}?firm=<firmId>`: the row of that firm, 404 for any other (FL-005). */
export async function getOperationRoute(ctx: RouteContext): Promise<PlatformResponse> {
  const operation = await requireOperation(ctx, operationScope(ctx));
  return jsonResponse(200, toPlatformOperation(operation));
}

/** `POST /v1/operations/{n}/eta?firm=<firmId>`: moves the ETA and publishes `CarrierEtaChanged`. */
export async function etaRoute(ctx: RouteContext): Promise<PlatformResponse> {
  const scope = operationScope(ctx);
  const request = parseOrInvalid(EtaChangeRequest, jsonBody(ctx.request), "body");
  return change(ctx, scope, request, (operation, eventId) => {
    const previous = instantMs(operation.eta);
    const next = instantMs(request.newEta);
    if (next === previous) throw conflict("ETA_UNCHANGED", "the new ETA is the current one");
    const event = carrierEtaChanged({
      eventId,
      firmId: scope.firmId,
      operationNumber: scope.operationNumber,
      vessel: operation.vessel,
      previousEta: operation.eta,
      newEta: request.newEta,
      reason: next < previous ? "SCHEDULE_ADVANCED" : "SCHEDULE_DELAYED",
      occurredAtSim: request.occurredAtSim,
    });
    return { patch: { eta: request.newEta }, event };
  });
}

/** Customs only moves forward: NONE → OFICIALIZADO → CANAL_ASIGNADO → LIBERADO (steps may be skipped). */
const DISPATCH_RANK: Readonly<Record<DispatchStatus, number>> = { NONE: 0, OFICIALIZADO: 1, CANAL_ASIGNADO: 2, LIBERADO: 3 };

/** `POST /v1/operations/{n}/customs-status?firm=<firmId>`: publishes `CustomsStatusChanged`. */
export async function customsStatusRoute(ctx: RouteContext): Promise<PlatformResponse> {
  const scope = operationScope(ctx);
  const request = parseOrInvalid(CustomsStatusRequest, jsonBody(ctx.request), "body");
  return change(ctx, scope, request, (operation, eventId) => {
    const current = operation.customs.status;
    if (DISPATCH_RANK[request.status] <= DISPATCH_RANK[current]) throw conflict("STATUS_NOT_FORWARD", `customs status is already ${current}`);
    // The assigned channel stays on the row after release, so the console can still show it.
    const channel = request.channel ?? operation.customs.channel;
    const customs: CustomsState = channel === undefined ? { status: request.status } : { status: request.status, channel };
    const event = customsStatusChanged({
      eventId,
      firmId: scope.firmId,
      operationNumber: scope.operationNumber,
      status: request.status,
      ...(request.channel === undefined ? {} : { channel: request.channel }),
      occurredAtSim: request.occurredAtSim,
    });
    return { patch: { customs }, event };
  });
}
