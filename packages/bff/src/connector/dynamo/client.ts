/// <reference path="../../../sst-env.d.ts" />
// TableClient over the DynamoDB DocumentClient. Physical table names come from the SST link
// (`Resource.<Table>.name` through lib/resource.ts); every call carries the SDK timeout of
// lib/clients.ts, and throttling (plus timeouts of reads) is retried with backoff on top of the SDK's
// own attempts (lib/retry.ts). This file and lib/clients.ts are the only ones that import
// @aws-sdk/lib-dynamodb (connector/boundary.test.ts).
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ConnectorError } from "@legajo/shared";
import { withRetry } from "../../lib/retry";
import { tableName, type TableName } from "../../lib/resource";
import { condition, keyCondition, omitEmpty, updateExpression } from "./expressions";
import { MAX_TRANSACT_OPS, type Item, type Key, type QuerySpec, type TableClient, type TransactOp, type UpdateOptions, type UpdateSpec, type WriteCondition } from "../table-client";

const BATCH_WRITE_MAX = 25;
const BATCH_WRITE_ROUNDS = 5;

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type WriteRequest = NonNullable<BatchWriteCommandInput["RequestItems"]>[string][number];

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/**
 * A cancelled transaction is a CONFLICT only when a condition failed; cancelled by a concurrent
 * transaction or by throttling, it is worth retrying.
 */
function cancelledByCondition(error: unknown): boolean {
  const reasons: unknown = error instanceof Error ? Reflect.get(error, "CancellationReasons") : undefined;
  if (!Array.isArray(reasons) || reasons.length === 0) return true;
  return reasons.some((reason: unknown) => typeof reason === "object" && reason !== null && Reflect.get(reason, "Code") === "ConditionalCheckFailed");
}

/** The row DynamoDB returns with a failed condition (`ReturnValuesOnConditionCheckFailure: ALL_OLD`). */
function oldItemOf(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, "Item") : undefined;
}

// Maps SDK failures to the typed connector error; unknown errors become UNAVAILABLE so the tool
// envelope never leaks SDK internals to the model.
export function toConnectorError(error: unknown, table: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const options = { cause: error };
  switch (errorName(error)) {
    case "ConditionalCheckFailedException":
      return new ConnectorError("CONFLICT", `condition failed on ${table}`, table, options);
    case "TransactionCanceledException":
      return cancelledByCondition(error)
        ? new ConnectorError("CONFLICT", `transaction condition failed on ${table}`, table, options)
        : new ConnectorError("THROTTLED", `transaction cancelled by contention on ${table}`, table, options);
    case "ProvisionedThroughputExceededException":
    case "ThrottlingException":
    case "RequestLimitExceeded":
    case "TransactionConflictException":
      return new ConnectorError("THROTTLED", `throttled on ${table}`, table, options);
    case "TimeoutError":
    case "AbortError":
      return new ConnectorError("TIMEOUT", `timeout on ${table}`, table, options);
    case "ValidationException":
      return new ConnectorError("VALIDATION", `invalid request on ${table}`, table, options);
    default:
      return new ConnectorError("UNAVAILABLE", `dynamodb failure on ${table}`, table, options);
  }
}

function isItem(value: Record<string, unknown> | undefined): value is Item {
  return value !== undefined && typeof value.PK === "string" && typeof value.SK === "string";
}

export interface DynamoTableClientOptions {
  /** Physical name resolver; defaults to the SST link. Tests inject a map. */
  readonly resolveName?: (table: TableName) => string;
  /** Backoff sleep, injected by tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class DynamoTableClient implements TableClient {
  private readonly resolveName: (table: TableName) => string;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    options: DynamoTableClientOptions = {},
  ) {
    this.resolveName = options.resolveName ?? tableName;
    this.sleep = options.sleep;
  }

  private async run<T>(table: TableName, operation: () => Promise<T>, retryTimeouts = false): Promise<T> {
    return withRetry(
      async () => {
        try {
          return await operation();
        } catch (error) {
          throw toConnectorError(error, table);
        }
      },
      {
        shouldRetry: (error) => error instanceof ConnectorError && (error.code === "THROTTLED" || (retryTimeouts && error.code === "TIMEOUT")),
        ...(this.sleep ? { sleep: this.sleep } : {}),
      },
    );
  }

  async get(table: TableName, key: Key): Promise<Item | undefined> {
    const output = await this.run(table, () => this.client.send(new GetCommand({ TableName: this.resolveName(table), Key: key, ConsistentRead: true })), true);
    return isItem(output.Item) ? output.Item : undefined;
  }

  async query(table: TableName, spec: QuerySpec): Promise<Item[]> {
    const built = keyCondition(table, spec);
    const items: Item[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      // With a filter, DynamoDB applies `Limit` before filtering: read whole pages and cut here.
      const remaining = spec.limit === undefined || built.filterExpression !== undefined ? undefined : spec.limit - items.length;
      const output = await this.run(
        table,
        () =>
          this.client.send(
            new QueryCommand({
              TableName: this.resolveName(table),
              IndexName: built.indexName,
              KeyConditionExpression: built.expression,
              FilterExpression: built.filterExpression,
              ExpressionAttributeNames: built.names,
              ExpressionAttributeValues: built.values,
              ScanIndexForward: !spec.descending,
              Limit: remaining,
              ExclusiveStartKey: startKey,
              // GSIs only support eventually consistent reads.
              ConsistentRead: built.indexName === undefined,
            }),
          ),
        true,
      );
      for (const row of output.Items ?? []) if (isItem(row)) items.push(row);
      startKey = output.LastEvaluatedKey;
    } while (startKey !== undefined && (spec.limit === undefined || items.length < spec.limit));
    return spec.limit === undefined ? items : items.slice(0, spec.limit);
  }

  async put(table: TableName, item: Item, cond?: WriteCondition): Promise<void> {
    const built = condition(cond);
    await this.run(table, () =>
      this.client.send(
        new PutCommand({
          TableName: this.resolveName(table),
          Item: item,
          ConditionExpression: built.expression,
          ExpressionAttributeNames: omitEmpty(built.names),
          ExpressionAttributeValues: omitEmpty(built.values),
        }),
      ),
    );
  }

  async update(table: TableName, key: Key, spec: UpdateSpec, updatedAt: string, options: UpdateOptions = {}): Promise<Item> {
    const built = updateExpression(spec, updatedAt, options);
    const send = () =>
      this.client.send(
        new UpdateCommand({
          TableName: this.resolveName(table),
          Key: key,
          UpdateExpression: built.expression,
          ConditionExpression: built.conditionExpression,
          ExpressionAttributeNames: built.names,
          ExpressionAttributeValues: built.values,
          ReturnValues: "ALL_NEW",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
    try {
      const output = await this.run(table, async () => {
        try {
          return await send();
        } catch (error) {
          // A failed condition on a row that does not exist is a missing row, not a conflict.
          if (errorName(error) === "ConditionalCheckFailedException" && oldItemOf(error) === undefined && options.upsert !== true && !options.condition?.ifNotExists) {
            throw new ConnectorError("NOT_FOUND", `${table} item ${key.PK}/${key.SK} not found`, table, { cause: error });
          }
          throw error;
        }
      });
      if (!isItem(output.Attributes)) throw new ConnectorError("UNAVAILABLE", `update on ${table} returned no item`, table);
      return output.Attributes;
    } catch (error) {
      throw toConnectorError(error, table);
    }
  }

  async delete(table: TableName, key: Key, cond?: WriteCondition): Promise<void> {
    const built = condition(cond);
    await this.run(table, () =>
      this.client.send(
        new DeleteCommand({
          TableName: this.resolveName(table),
          Key: key,
          ConditionExpression: built.expression,
          ExpressionAttributeNames: omitEmpty(built.names),
          ExpressionAttributeValues: omitEmpty(built.values),
        }),
      ),
    );
  }

  private toTransactItem(op: TransactOp): TransactItem {
    const name = this.resolveName(op.table);
    switch (op.op) {
      case "put": {
        const built = condition(op.condition);
        return { Put: { TableName: name, Item: op.item, ConditionExpression: built.expression, ExpressionAttributeNames: omitEmpty(built.names), ExpressionAttributeValues: omitEmpty(built.values) } };
      }
      case "update": {
        const built = updateExpression(op.spec, op.updatedAt, op.options);
        return {
          Update: {
            TableName: name,
            Key: op.key,
            UpdateExpression: built.expression,
            ConditionExpression: built.conditionExpression,
            ExpressionAttributeNames: built.names,
            ExpressionAttributeValues: built.values,
          },
        };
      }
      case "delete": {
        const built = condition(op.condition);
        return { Delete: { TableName: name, Key: op.key, ConditionExpression: built.expression, ExpressionAttributeNames: omitEmpty(built.names), ExpressionAttributeValues: omitEmpty(built.values) } };
      }
      case "check": {
        const built = condition(op.condition);
        if (built.expression === undefined) throw new RangeError("a condition check needs a condition");
        return { ConditionCheck: { TableName: name, Key: op.key, ConditionExpression: built.expression, ExpressionAttributeNames: omitEmpty(built.names), ExpressionAttributeValues: omitEmpty(built.values) } };
      }
    }
  }

  async transact(ops: readonly TransactOp[]): Promise<void> {
    if (ops.length === 0) return;
    if (ops.length > MAX_TRANSACT_OPS) throw new ConnectorError("VALIDATION", `a transaction takes at most ${MAX_TRANSACT_OPS} operations`);
    const table = ops[0]?.table ?? "Runtime";
    const items = ops.map((op) => this.toTransactItem(op));
    await this.run(table, () => this.client.send(new TransactWriteCommand({ TransactItems: items })));
  }

  private async batchWrite(table: TableName, requests: readonly WriteRequest[]): Promise<void> {
    const name = this.resolveName(table);
    for (let offset = 0; offset < requests.length; offset += BATCH_WRITE_MAX) {
      let pending: WriteRequest[] = requests.slice(offset, offset + BATCH_WRITE_MAX);
      for (let round = 0; pending.length > 0; round += 1) {
        if (round >= BATCH_WRITE_ROUNDS) throw new ConnectorError("THROTTLED", `batch write on ${table} left ${pending.length} unprocessed requests`, table);
        const batch = pending;
        const output = await this.run(table, () => this.client.send(new BatchWriteCommand({ RequestItems: { [name]: batch } })));
        pending = output.UnprocessedItems?.[name] ?? [];
      }
    }
  }

  async batchPut(table: TableName, items: readonly Item[]): Promise<void> {
    await this.batchWrite(
      table,
      items.map((item) => ({ PutRequest: { Item: item } })),
    );
  }

  async batchDelete(table: TableName, keys: readonly Key[]): Promise<void> {
    await this.batchWrite(
      table,
      keys.map((key) => ({ DeleteRequest: { Key: { PK: key.PK, SK: key.SK } } })),
    );
  }
}
