// DynamoDB adapter of the `ReaderCatalog` port. Every item is validated with its zod schema on the
// way in; a malformed item is an error, never a reading. The client has explicit timeouts and the
// SDK's own retries with backoff (CLAUDE.md: "toda llamada externa con timeout y reintento").
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { FaultItem, GroundTruthItem, IdempotencyItem, catalogKeys, isLive, type CatalogStore } from "./catalog";

/** The two commands the adapter sends; the production value wraps a DocumentClient. */
export type DocumentSend = (command: GetCommand | PutCommand) => Promise<{ readonly Item?: Record<string, unknown> }>;

export function documentSend(client: DynamoDBDocumentClient): DocumentSend {
  return async (command) => {
    if (command instanceof GetCommand) return client.send(command);
    await client.send(command);
    return {};
  };
}

/** DocumentClient for the mock's Lambda: 2 s per request, 1 s to connect, 3 SDK attempts. */
export function catalogDocumentClient(): DynamoDBDocumentClient {
  const base = new DynamoDBClient({ maxAttempts: 3, requestHandler: { requestTimeout: 2_000, connectionTimeout: 1_000 } });
  return DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
}

function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export function createDynamoCatalog(tableName: string, send: DocumentSend): CatalogStore {
  async function get(PK: string, SK: string, consistent = false): Promise<Record<string, unknown> | undefined> {
    const output = await send(new GetCommand({ TableName: tableName, Key: { PK, SK }, ConsistentRead: consistent }));
    return output.Item;
  }

  return {
    async groundTruth(key) {
      const item = await get("sha256" in key ? catalogKeys.sha(key.sha256) : catalogKeys.docId(key.docId), "READING");
      return item === undefined ? undefined : GroundTruthItem.parse(item).reading;
    },
    async faults(clockId) {
      const item = await get(catalogKeys.faultsPk, catalogKeys.faults(clockId));
      return item === undefined ? undefined : FaultItem.parse(item);
    },
    async cachedReading(idempotencyKey, sha256, now) {
      const item = await get(catalogKeys.idempotency(idempotencyKey, sha256), "META", true);
      if (item === undefined) return undefined;
      const parsed = IdempotencyItem.parse(item);
      return isLive(parsed, now) ? parsed : undefined;
    },
    async cacheReading(item) {
      try {
        // A leftover past its TTL (not yet swept) is overwritten; a live one wins the race.
        await send(
          new PutCommand({
            TableName: tableName,
            Item: IdempotencyItem.parse(item),
            ConditionExpression: "attribute_not_exists(PK) OR expiresAt <= :now",
            ExpressionAttributeValues: { ":now": Math.floor(new Date(item.createdAt).getTime() / 1000) },
          }),
        );
        return item;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
        const existing = await get(item.PK, item.SK, true);
        return existing === undefined ? item : IdempotencyItem.parse(existing);
      }
    },
  };
}
