import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { GroundTruthItem, faultItem, groundTruthItems, idempotencyItem, type GroundTruthReading } from "./catalog";
import { createDynamoCatalog, type DocumentSend } from "./dynamo-catalog";
import { composeReading, readingIdOf } from "./reading";

vi.mock("sst", () => ({
  Resource: new Proxy(
    { ReaderCatalog: { name: "ReaderCatalogTable" }, ReaderMockConfig: { documentsBucket: "documents-bucket" } },
    {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (value === undefined) throw new Error(`${String(property)} is not linked`);
        return value;
      },
    },
  ),
}));

const SHA = "b".repeat(64);
const TRUTH: GroundTruthReading = { status: "RECOGNIZED", docType: "CERTIFICATE_OF_ORIGIN", confidence: 0.41, fields: { signed: true, stamped: false }, observations: [{ code: "LOW_CONFIDENCE", severity: "BLOCKING" }] };
const NOW = new Date("2026-10-15T13:00:00.000Z");

function table(items: Record<string, Record<string, unknown>>, options: { conditionFails?: boolean } = {}) {
  const sent: Array<GetCommand | PutCommand> = [];
  const send: DocumentSend = async (command) => {
    sent.push(command);
    if (command instanceof GetCommand) return { Item: items[`${String(command.input.Key?.PK)}|${String(command.input.Key?.SK)}`] };
    if (options.conditionFails) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
    return {};
  };
  return { sent, catalog: createDynamoCatalog("ReaderCatalogTable", send) };
}

describe("ReaderCatalog items", () => {
  it("builds the two ground-truth items of a synthetic PDF, by hash and by embedded id", () => {
    const [bySha, byId] = groundTruthItems({ sha256: SHA, docId: "LDOC-4481-CO-v1", reading: TRUTH }, { createdAt: "2026-10-14T13:30:00.000Z" });
    expect([bySha.PK, byId.PK]).toEqual([`SHA#${SHA}`, "DOCID#LDOC-4481-CO-v1"]);
    expect(bySha).toMatchObject({ SK: "READING", entity: "GroundTruthReading", reading: TRUTH, createdAt: "2026-10-14T13:30:00.000Z" });
    expect(GroundTruthItem.safeParse({ ...bySha, PK: "SHA#other" }).success).toBe(false);
    expect(() => groundTruthItems({ sha256: SHA, docId: "LDOC-4481-CO-v1", reading: { ...TRUTH, confidence: 1.2 } })).toThrow();
  });

  it("builds a fault item that expires with its QA world", () => {
    const item = faultItem("qa-812-1-sc19", { mode: "TIMEOUT", until: "2026-10-15T14:00:00Z" }, NOW);
    expect(item).toMatchObject({ PK: "CONFIG", SK: "FAULTS#qa-812-1-sc19", rate: 1, expiresAt: NOW.getTime() / 1000 + 48 * 3600 });
    expect(() => faultItem("sim-batch-1", { mode: "TIMEOUT", until: "2026-10-15T14:00:00Z" }, NOW)).toThrow(RangeError);
  });
});

describe("DynamoDB adapter of ReaderCatalog", () => {
  it("reads ground truth by SHA-256 and by embedded id, and validates it", async () => {
    const [bySha, byId] = groundTruthItems({ sha256: SHA, docId: "LDOC-4481-CO-v1", reading: TRUTH });
    const { catalog, sent } = table({ [`${bySha.PK}|READING`]: bySha, [`${byId.PK}|READING`]: byId, "DOCID#LDOC-4400-CI-v1|READING": { PK: "DOCID#LDOC-4400-CI-v1", SK: "READING" } });
    expect(await catalog.groundTruth({ sha256: SHA })).toEqual(TRUTH);
    expect(await catalog.groundTruth({ docId: "LDOC-4481-CO-v1" })).toEqual(TRUTH);
    expect(await catalog.groundTruth({ sha256: "c".repeat(64) })).toBeUndefined();
    await expect(catalog.groundTruth({ docId: "LDOC-4400-CI-v1" })).rejects.toThrow();
    expect(sent[0]?.input).toMatchObject({ TableName: "ReaderCatalogTable", Key: { PK: `SHA#${SHA}`, SK: "READING" } });
  });

  it("reads faults by clock", async () => {
    const item = faultItem("qa-812-1-sc19", { mode: "ERROR_503", until: "2026-10-15T14:00:00Z" }, NOW);
    const { catalog } = table({ "CONFIG|FAULTS#qa-812-1-sc19": item });
    expect(await catalog.faults("qa-812-1-sc19")).toEqual(item);
    expect(await catalog.faults("qa-812-1-sc01")).toBeUndefined();
  });

  it("caches a reading with a conditional put, keeps the one that won a race and ignores expired ones", async () => {
    const reading = composeReading(readingIdOf("dv-4481-CO-1", SHA), { by: "SHA256", truth: TRUTH });
    const item = idempotencyItem("dv-4481-CO-1", SHA, reading, NOW);
    const fresh = table({});
    expect(await fresh.catalog.cacheReading(item)).toEqual(item);
    expect(fresh.sent[0]).toBeInstanceOf(PutCommand);
    expect(fresh.sent[0]?.input).toMatchObject({ ConditionExpression: "attribute_not_exists(PK) OR expiresAt <= :now" });

    const winner = { ...item, createdAt: "2026-10-15T12:59:00.000Z" };
    const raced = table({ [`${item.PK}|META`]: winner }, { conditionFails: true });
    expect(await raced.catalog.cacheReading(item)).toEqual(winner);

    const expired = table({ [`${item.PK}|META`]: { ...item, expiresAt: NOW.getTime() / 1000 } });
    expect(await expired.catalog.cachedReading("dv-4481-CO-1", SHA, NOW)).toBeUndefined();
    expect(await raced.catalog.cachedReading("dv-4481-CO-1", SHA, NOW)).toEqual(winner);
    expect(raced.sent.at(-1)?.input).toMatchObject({ ConsistentRead: true });
  });
});

describe("ReaderMock Lambda handler", () => {
  function event(overrides: Partial<LambdaFunctionURLEvent>): LambdaFunctionURLEvent {
    return {
      version: "2.0",
      routeKey: "$default",
      rawPath: "/v1/health",
      rawQueryString: "",
      headers: {},
      isBase64Encoded: false,
      requestContext: { requestId: "req-1", http: { method: "GET", path: "/v1/health", protocol: "HTTP/1.1", sourceIp: "10.0.0.1", userAgent: "test" } },
      ...overrides,
    } as LambdaFunctionURLEvent;
  }

  it("maps a Function URL event to the app and back, decoding base64 bodies", async () => {
    const { handler, toReaderRequest } = await import("./handler");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const response = await handler(event({}));
      expect(response).toMatchObject({ statusCode: 200, headers: { "content-type": "application/json" } });
      expect(String(write.mock.calls[0]?.[0])).toContain('"correlationId":"req-1"');
    } finally {
      write.mockRestore();
    }
    const request = toReaderRequest(event({ rawPath: "/v1/readings", body: Buffer.from('{"a":1}').toString("base64"), isBase64Encoded: true }));
    expect(request).toMatchObject({ path: "/v1/readings", body: '{"a":1}' });
  });
});
