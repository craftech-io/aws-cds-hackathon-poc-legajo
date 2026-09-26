import { PutEventsCommand, type PutEventsCommandOutput } from "@aws-sdk/client-eventbridge";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@legajo/shared";
import { createDynamoPlatformStore, toConnectorError, type DocumentSender } from "./dynamo-store";
import { carrierEtaChanged } from "./events";
import { createFunctionUrlHandler, type FunctionUrlEvent } from "./lambda";
import { createEventBridgePublisher, createRecordingPublisher, type EventBridgeSender } from "./publisher";
import { CustomsState, PlatformOperationItem, ZonedInstant, toPlatformOperationItem } from "./schema";
import { createMemoryPlatformStore, toPlatformEventItem } from "./store";
import { FIXED_NOW, operation4471, operationItem, sequentialEventIds, steppingClock } from "./testing";

function fakeSender(respond: (command: unknown) => unknown) {
  const sent: unknown[] = [];
  const send = async (command: unknown) => {
    sent.push(command);
    return respond(command);
  };
  return { sent, client: { send } as unknown as DocumentSender & EventBridgeSender };
}

function sdkError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${name} from the SDK`), { name, ...extra });
}

const EVENT = carrierEtaChanged({
  eventId: sequentialEventIds()(),
  firmId: "firm-delta",
  operationNumber: "4471",
  vessel: "Austral Aurora",
  previousEta: "2026-10-22T08:00:00-03:00",
  newEta: "2026-10-20T08:00:00-03:00",
  reason: "SCHEDULE_ADVANCED",
  occurredAtSim: "2026-10-16T09:30:00-03:00",
});

describe("DynamoDB store", () => {
  it("reads META with a consistent GetItem and validates the row", async () => {
    const item = operationItem();
    const { client, sent } = fakeSender((command) => (command instanceof GetCommand && command.input.Key?.PK === item.PK ? { Item: item } : {}));
    const store = createDynamoPlatformStore({ client, tableName: "platform-table" });

    await expect(store.getOperation("firm-delta", "4471")).resolves.toEqual(item);
    await expect(store.getOperation("firm-norte", "4471")).resolves.toBeUndefined();
    expect((sent[0] as GetCommand).input).toEqual({ TableName: "platform-table", Key: { PK: "POP#firm-delta#4471", SK: "META" }, ConsistentRead: true });

    const corrupt = createDynamoPlatformStore({ client: fakeSender(() => ({ Item: { ...item, vessel: "" } })).client, tableName: "t" });
    await expect(corrupt.getOperation("firm-delta", "4471")).rejects.toMatchObject({ name: "ConnectorError", code: "VALIDATION" });
  });

  it("finds an earlier event by Idempotency-Key across query pages", async () => {
    const eventItem = toPlatformEventItem(operationItem(), EVENT, { idempotencyKey: "k-1", requestHash: "a".repeat(64), now: FIXED_NOW });
    let page = 0;
    const { client, sent } = fakeSender(() => {
      page += 1;
      return page === 1 ? { Items: [], LastEvaluatedKey: { PK: eventItem.PK, SK: "EVT#0" } } : { Items: [eventItem] };
    });
    const store = createDynamoPlatformStore({ client, tableName: "t" });

    await expect(store.findEvent("firm-delta", "4471", "k-1")).resolves.toEqual(eventItem);
    const [first, second] = sent as QueryCommand[];
    expect(first?.input).toMatchObject({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :evt)",
      FilterExpression: "idempotencyKey = :key",
      ExpressionAttributeValues: { ":pk": "POP#firm-delta#4471", ":evt": "EVT#", ":key": "k-1" },
      ConsistentRead: true,
    });
    expect(first?.input).not.toHaveProperty("ExclusiveStartKey");
    expect(second?.input.ExclusiveStartKey).toEqual({ PK: eventItem.PK, SK: "EVT#0" });

    const empty = createDynamoPlatformStore({ client: fakeSender(() => ({ Items: [] })).client, tableName: "t" });
    await expect(empty.findEvent("firm-delta", "4471", "k-2")).resolves.toBeUndefined();
  });

  it("commits the conditional update of META and the event row in one transaction", async () => {
    const operation = operationItem();
    const eventItem = toPlatformEventItem(operation, EVENT, { idempotencyKey: "k-1", requestHash: "b".repeat(64), now: FIXED_NOW });
    const { client, sent } = fakeSender(() => ({}));
    const store = createDynamoPlatformStore({ client, tableName: "t" });

    await store.commit({ operation, patch: { eta: "2026-10-20T08:00:00-03:00" }, eventItem, now: FIXED_NOW });

    const input = (sent[0] as TransactWriteCommand).input;
    const [update, put] = input.TransactItems ?? [];
    expect(update?.Update).toMatchObject({
      TableName: "t",
      Key: { PK: "POP#firm-delta#4471", SK: "META" },
      UpdateExpression: "SET #version = :next, #updatedAt = :updatedAt, #eta = :eta",
      ConditionExpression: "#version = :expected",
      ExpressionAttributeValues: { ":expected": 1, ":next": 2, ":eta": "2026-10-20T08:00:00-03:00", ":updatedAt": FIXED_NOW.toISOString() },
    });
    expect(update?.Update?.ExpressionAttributeValues).not.toHaveProperty(":customs");
    expect(put?.Put).toEqual({ TableName: "t", Item: eventItem, ConditionExpression: "attribute_not_exists(PK)" });
  });

  it("maps SDK failures to ConnectorError codes", async () => {
    const cases: Array<[Error, string]> = [
      [sdkError("TransactionCanceledException", { CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] }), "CONFLICT"],
      [sdkError("TransactionCanceledException", { CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }] }), "THROTTLED"],
      [sdkError("ConditionalCheckFailedException"), "CONFLICT"],
      [sdkError("ProvisionedThroughputExceededException"), "THROTTLED"],
      [sdkError("TimeoutError"), "TIMEOUT"],
      [sdkError("InternalServerError"), "UNAVAILABLE"],
    ];
    for (const [error, code] of cases) expect(toConnectorError(error, "op").code, error.name).toBe(code);

    const store = createDynamoPlatformStore({ client: fakeSender(() => Promise.reject(sdkError("ThrottlingException"))).client, tableName: "t" });
    await expect(store.getOperation("firm-delta", "4471")).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe("EventBridge publisher", () => {
  it("puts one entry on the Feeds bus with the source, the detail type and the detail as JSON", async () => {
    const { client, sent } = fakeSender((): Partial<PutEventsCommandOutput> => ({ FailedEntryCount: 0, Entries: [{ EventId: "x" }] }));
    await createEventBridgePublisher({ client, busName: "feeds-bus" }).publish(EVENT);

    const command = sent[0] as PutEventsCommand;
    expect(command).toBeInstanceOf(PutEventsCommand);
    const [entry] = command.input.Entries ?? [];
    expect(entry).toMatchObject({ EventBusName: "feeds-bus", Source: "mock.platform.carrier", DetailType: "CarrierEtaChanged" });
    expect(JSON.parse(entry?.Detail ?? "{}")).toEqual(EVENT.detail);
  });

  it("fails as UNAVAILABLE when the entry is rejected or the call fails", async () => {
    const rejected = fakeSender(() => ({ FailedEntryCount: 1, Entries: [{ ErrorCode: "InternalFailure" }] }));
    await expect(createEventBridgePublisher({ client: rejected.client, busName: "b" }).publish(EVENT)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const down = fakeSender(() => Promise.reject(sdkError("ServiceUnavailable")));
    await expect(createEventBridgePublisher({ client: down.client, busName: "b" }).publish(EVENT)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

function urlEvent(overrides: Partial<FunctionUrlEvent> & { method?: string } = {}): FunctionUrlEvent {
  const { method = "GET", ...rest } = overrides;
  return { rawPath: "/v1/health", rawQueryString: "", headers: {}, isBase64Encoded: false, requestContext: { requestId: "req-00000001", http: { method } }, ...rest };
}

describe("Function URL handler", () => {
  const deps = () => ({ store: createMemoryPlatformStore([operationItem()]), publisher: createRecordingPublisher(), now: steppingClock(), log: () => undefined });

  it("maps a Function URL event onto the app, query and base64 body included", async () => {
    const handler = createFunctionUrlHandler(deps, { log: () => undefined });
    const got = await handler(urlEvent({ rawPath: "/v1/operations/4471", rawQueryString: "firm=firm-delta" }));
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["x-correlation-id"]).toBe("req-00000001");
    expect(JSON.parse(got.body)).toMatchObject({ operationNumber: "4471" });

    const body = Buffer.from(JSON.stringify({ newEta: "2026-10-20T08:00:00-03:00", occurredAtSim: "2026-10-16T09:30:00-03:00" })).toString("base64");
    const posted = await handler(
      urlEvent({ method: "POST", rawPath: "/v1/operations/4471/eta", rawQueryString: "firm=firm-delta", headers: { "idempotency-key": "k-1" }, body, isBase64Encoded: true }),
    );
    expect(posted.statusCode).toBe(200);
  });

  it("answers 400 to an event that is not a Function URL request", async () => {
    const handler = createFunctionUrlHandler(deps, { log: () => undefined });
    expect((await handler({ Records: [] })).statusCode).toBe(400);
  });

  it("answers 503 while its resources cannot be resolved and recovers on a later request", async () => {
    let attempts = 0;
    const logs: unknown[] = [];
    const handler = createFunctionUrlHandler(
      () => {
        attempts += 1;
        if (attempts === 1) throw new Error('"Platform" is not linked');
        return deps();
      },
      { log: (record) => logs.push(record) },
    );
    const first = await handler(urlEvent());
    expect(first.statusCode).toBe(503);
    expect(first.headers["retry-after"]).toBe("1");
    expect(logs).toHaveLength(1);
    expect((await handler(urlEvent())).statusCode).toBe(200);
    expect((await handler(urlEvent())).statusCode).toBe(200);
    expect(attempts).toBe(2);
  });
});

describe("row schema", () => {
  it("builds the META row the world factory writes, with defaults and only the world attributes that are set", () => {
    const { documents, ...withoutDocuments } = operation4471();
    void documents;
    const item = toPlatformOperationItem(withoutDocuments, { now: FIXED_NOW, clockId: "qa-812-1-sc10", world: "qa", runId: "812-1", expiresAt: 1_790_000_000, synthetic: true });
    expect(item).toMatchObject({
      PK: "POP#firm-delta#4471",
      SK: "META",
      entity: "PlatformOperation",
      version: 1,
      createdAt: FIXED_NOW.toISOString(),
      documents: { COMMERCIAL_INVOICE: "MISSING", PACKING_LIST: "MISSING", CERTIFICATE_OF_ORIGIN: "MISSING" },
      customs: { status: "NONE" },
      world: "qa",
      synthetic: true,
    });
    expect(operationItem()).not.toHaveProperty("world");
    expect(operationItem()).not.toHaveProperty("expiresAt");
  });

  it("rejects a key that does not match the row, an unknown attribute and malformed values", () => {
    const item = operationItem();
    expect(PlatformOperationItem.safeParse({ ...item, PK: "POP#firm-norte#4471" }).success).toBe(false);
    expect(PlatformOperationItem.safeParse({ ...item, note: "x" }).success).toBe(false);
    expect(PlatformOperationItem.safeParse({ ...item, incoterm: "FOBX" }).success).toBe(false);
    expect(CustomsState.safeParse({ status: "OFICIALIZADO", channel: "VERDE" }).success).toBe(false);
    expect(CustomsState.safeParse({ status: "LIBERADO", channel: "VERDE" }).success).toBe(true);
    expect(ZonedInstant.safeParse("2026-10-22T08:00:00").success).toBe(false);
    expect(ZonedInstant.safeParse("2026-10-22T08:00:00-03:00").success).toBe(true);
  });
});
