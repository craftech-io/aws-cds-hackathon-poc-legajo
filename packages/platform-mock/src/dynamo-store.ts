// DynamoDB adapter of the platform mock's store (table `Platform`, docs/architecture.md §5). Reads are
// strongly consistent (a change reads the row it is about to condition on); a change is one
// `TransactWriteItems`: the conditional update of `META` on its `version` and the `EVT#` row. SDK
// failures leave this module as `ConnectorError`s, so the app maps them to HTTP without knowing the SDK.
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ConnectorError } from "@legajo/shared";
import { PLATFORM_EVENT_SK_PREFIX, PLATFORM_META_SK, PlatformOperationItem, platformPk } from "./schema";
import { PLATFORM_TABLE, PlatformEventItem, parseStored, type PlatformChange, type PlatformOperationPatch, type PlatformStore } from "./store";

export type DocumentSender = Pick<DynamoDBDocumentClient, "send">;

export interface DynamoPlatformStoreOptions {
  readonly client: DocumentSender;
  /** Physical name of `Platform` (`Resource.Platform.name`). */
  readonly tableName: string;
}

/** An operation has a handful of events; this bounds a runaway query, not a real partition. */
const MAX_EVENT_PAGES = 10;

const THROTTLED = new Set(["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"]);
const TIMEOUT = new Set(["TimeoutError", "AbortError", "RequestTimeout", "RequestTimeoutException"]);

function cancellationCodes(error: object): string[] {
  const reasons: unknown = Reflect.get(error, "CancellationReasons");
  if (!Array.isArray(reasons)) return [];
  return reasons.map((reason: unknown) => (typeof reason === "object" && reason !== null ? String(Reflect.get(reason, "Code") ?? "None") : "None"));
}

/** Maps an SDK failure to a ConnectorError; one that already is one passes through. */
export function toConnectorError(error: unknown, operation: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const name = error instanceof Error ? error.name : "UnknownError";
  const options = { cause: error };
  if (name === "ConditionalCheckFailedException") return new ConnectorError("CONFLICT", `${operation}: condition failed`, PLATFORM_TABLE, options);
  if (name === "TransactionCanceledException" && error instanceof Error) {
    const codes = cancellationCodes(error);
    if (codes.includes("ConditionalCheckFailed")) return new ConnectorError("CONFLICT", `${operation}: condition failed`, PLATFORM_TABLE, options);
    if (codes.some((code) => code === "TransactionConflict" || code === "ThrottlingError")) {
      return new ConnectorError("THROTTLED", `${operation}: concurrent transaction`, PLATFORM_TABLE, options);
    }
  }
  if (THROTTLED.has(name)) return new ConnectorError("THROTTLED", `${operation}: throttled`, PLATFORM_TABLE, options);
  if (TIMEOUT.has(name)) return new ConnectorError("TIMEOUT", `${operation}: timed out`, PLATFORM_TABLE, options);
  return new ConnectorError("UNAVAILABLE", `${operation}: ${name}`, PLATFORM_TABLE, options);
}

async function attempt<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toConnectorError(error, operation);
  }
}

/** `SET` clause of a patch; attribute names always go through placeholders. */
export function patchExpression(patch: PlatformOperationPatch, now: Date, expectedVersion: number) {
  const names: Record<string, string> = { "#version": "version", "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":expected": expectedVersion, ":next": expectedVersion + 1, ":updatedAt": now.toISOString() };
  const sets = ["#version = :next", "#updatedAt = :updatedAt"];
  for (const field of ["eta", "customs"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    sets.push(`#${field} = :${field}`);
  }
  return {
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: "#version = :expected",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

export function createDynamoPlatformStore(options: DynamoPlatformStoreOptions): PlatformStore {
  const { client, tableName } = options;

  return {
    async getOperation(firmId, operationNumber) {
      const output = await attempt("GetItem", () =>
        client.send(new GetCommand({ TableName: tableName, Key: { PK: platformPk(firmId, operationNumber), SK: PLATFORM_META_SK }, ConsistentRead: true })),
      );
      return output.Item === undefined ? undefined : parseStored(PlatformOperationItem, output.Item, "operation");
    },

    async findEvent(firmId, operationNumber, idempotencyKey) {
      let startKey: Record<string, unknown> | undefined;
      for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
        const output = await attempt("Query", () =>
          client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: "PK = :pk AND begins_with(SK, :evt)",
              FilterExpression: "idempotencyKey = :key",
              ExpressionAttributeValues: { ":pk": platformPk(firmId, operationNumber), ":evt": PLATFORM_EVENT_SK_PREFIX, ":key": idempotencyKey },
              ConsistentRead: true,
              ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
            }),
          ),
        );
        const found = output.Items?.[0];
        if (found !== undefined) return parseStored(PlatformEventItem, found, "event");
        startKey = output.LastEvaluatedKey;
        if (startKey === undefined) return undefined;
      }
      throw new ConnectorError("UNAVAILABLE", "Query: too many event pages", PLATFORM_TABLE);
    },

    async commit(change: PlatformChange) {
      const update = patchExpression(change.patch, change.now, change.operation.version);
      await attempt("TransactWriteItems", () =>
        client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Update: { TableName: tableName, Key: { PK: change.operation.PK, SK: PLATFORM_META_SK }, ...update } },
              { Put: { TableName: tableName, Item: PlatformEventItem.parse(change.eventItem), ConditionExpression: "attribute_not_exists(PK)" } },
            ],
          }),
        ),
      );
    },
  };
}
