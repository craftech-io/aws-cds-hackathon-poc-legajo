import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { DynamoTableClient, toConnectorError } from "./client";

const docMock = mockClient(DynamoDBDocumentClient);
const resolveName = (table: string) => `poc-${table}`;

function awsError(name: string, extra: Record<string, unknown> = {}): Error {
  const error = Object.assign(new Error(name), extra);
  error.name = name;
  return error;
}

describe("DynamoTableClient", () => {
  let client: DynamoTableClient;

  beforeEach(() => {
    docMock.reset();
    client = new DynamoTableClient(DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })), { resolveName, sleep: async () => undefined });
  });

  it("resolves the physical table name and reads consistently", async () => {
    docMock.on(GetCommand).resolves({ Item: { PK: "IMP#imp-norpampa", SK: "META", entity: "Importer" } });
    expect(await client.get("Parties", { PK: "IMP#imp-norpampa", SK: "META" })).toMatchObject({ entity: "Importer" });
    expect(docMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({ TableName: "poc-Parties", ConsistentRead: true });
  });

  it("pages through a query, reads GSIs eventually consistent and cuts a filtered query after the filter", async () => {
    docMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ PK: "OP#a", SK: "META" }], LastEvaluatedKey: { PK: "OP#a", SK: "META" } })
      .resolvesOnce({ Items: [{ PK: "OP#b", SK: "META" }, { PK: "OP#c", SK: "META" }] });
    const rows = await client.query("Operations", { index: "GSI1", hashValue: "FIRM#firm-delta#OPEN", filter: { equals: { importerId: "imp-norpampa" } }, limit: 2 });
    expect(rows.map((row) => row.PK)).toEqual(["OP#a", "OP#b"]);
    const [first, second] = docMock.commandCalls(QueryCommand).map((call) => call.args[0].input);
    expect(first).toMatchObject({ IndexName: "GSI1", ConsistentRead: false, FilterExpression: "#n2 = :v3" });
    expect(first?.Limit).toBeUndefined();
    expect(second?.ExclusiveStartKey).toEqual({ PK: "OP#a", SK: "META" });
  });

  it("maps a failed condition to CONFLICT, and to NOT_FOUND when the row does not exist", async () => {
    docMock.on(PutCommand).rejects(awsError("ConditionalCheckFailedException"));
    await expect(client.put("Operations", { PK: "OP#1", SK: "META" }, { ifNotExists: true })).rejects.toMatchObject({ code: "CONFLICT", table: "Operations" });
    docMock.on(UpdateCommand).rejectsOnce(awsError("ConditionalCheckFailedException")).rejectsOnce(awsError("ConditionalCheckFailedException", { Item: { PK: { S: "OP#1" } } }));
    await expect(client.update("Operations", { PK: "OP#1", SK: "META" }, { set: { control: "BROKER" } }, "now", { condition: { ifVersion: 2 } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.update("Operations", { PK: "OP#1", SK: "META" }, { set: { control: "BROKER" } }, "now", { condition: { ifVersion: 2 } })).rejects.toMatchObject({ code: "CONFLICT" });
    const input = docMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ ReturnValues: "ALL_NEW", ReturnValuesOnConditionCheckFailure: "ALL_OLD", TableName: "poc-Operations" });
    expect(input?.ConditionExpression).toContain("attribute_exists");
  });

  it("retries throttling with backoff and then succeeds", async () => {
    docMock.on(GetCommand).rejectsOnce(awsError("ProvisionedThroughputExceededException")).resolvesOnce({ Item: { PK: "X", SK: "META" } });
    expect((await client.get("Runtime", { PK: "X", SK: "META" }))?.PK).toBe("X");
    expect(docMock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it("does not retry a timeout of a write (it may have been applied)", async () => {
    docMock.on(DeleteCommand).rejects(awsError("TimeoutError"));
    await expect(client.delete("Runtime", { PK: "X", SK: "META" })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(docMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it("sends a transaction with conditions and a condition check", async () => {
    docMock.on(TransactWriteCommand).resolves({});
    await client.transact([
      { op: "put", table: "Parties", item: { PK: "ADDR#h", SK: "CLAIM" }, condition: { ifNotExists: true } },
      { op: "update", table: "Operations", key: { PK: "OP#1", SK: "META" }, spec: { add: { sessionEpoch: 1 } }, updatedAt: "now" },
      { op: "check", table: "Runtime", key: { PK: "TOMB#c#1", SK: "META" }, condition: { ifNotExists: true } },
    ]);
    const items = docMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items?.[0]?.Put).toMatchObject({ TableName: "poc-Parties", ConditionExpression: "attribute_not_exists(#n0)" });
    expect(items?.[1]?.Update?.TableName).toBe("poc-Operations");
    expect(items?.[2]?.ConditionCheck).toMatchObject({ TableName: "poc-Runtime", ConditionExpression: "attribute_not_exists(#n0)" });
  });

  it("maps a cancelled transaction by its reasons: a failed condition is a CONFLICT, contention is retried", async () => {
    docMock
      .on(TransactWriteCommand)
      .rejectsOnce(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }] }))
      .rejectsOnce(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] }));
    await expect(client.transact([{ op: "put", table: "Parties", item: { PK: "A", SK: "B" }, condition: { ifNotExists: true } }])).rejects.toMatchObject({ code: "CONFLICT" });
    expect(docMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  it("chunks batch writes by 25 and retries unprocessed requests, deletes included", async () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ PK: "REF#HOLIDAY#AR", SK: `2026-10-${index.toString().padStart(2, "0")}` }));
    docMock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { "poc-Reference": [{ PutRequest: { Item: items[0] } }] } })
      .resolves({});
    await client.batchPut("Reference", items);
    await client.batchDelete("Reference", [{ PK: "REF#HOLIDAY#AR", SK: "2026-10-00" }]);
    const calls = docMock.commandCalls(BatchWriteCommand).map((call) => call.args[0].input.RequestItems?.["poc-Reference"]);
    expect(calls.map((requests) => requests?.length)).toEqual([25, 1, 5, 1]);
    expect(calls[3]?.[0]).toEqual({ DeleteRequest: { Key: { PK: "REF#HOLIDAY#AR", SK: "2026-10-00" } } });
  });
});

describe("toConnectorError", () => {
  it("classifies SDK errors and hides unknown ones as UNAVAILABLE", () => {
    expect(toConnectorError(awsError("ThrottlingException"), "Runtime").code).toBe("THROTTLED");
    expect(toConnectorError(awsError("TimeoutError"), "Runtime").code).toBe("TIMEOUT");
    expect(toConnectorError(awsError("ValidationException"), "Runtime").code).toBe("VALIDATION");
    expect(toConnectorError(new Error("boom"), "Runtime")).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });
});
