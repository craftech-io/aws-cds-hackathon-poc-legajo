import { NodeHttpHandler } from "@smithy/node-http-handler";
import { describe, expect, it } from "vitest";
import { DYNAMO_TIMEOUTS, awsClientConfig, createDocumentClient, dynamoDocumentClient } from "./clients";

describe("lib/clients", () => {
  it("gives every AWS client a request timeout, a connection timeout and a bounded number of attempts", () => {
    const config = awsClientConfig({ requestTimeoutMs: 1_500, connectionTimeoutMs: 500, maxAttempts: 2 });
    expect(config.maxAttempts).toBe(2);
    expect(config.requestHandler).toBeInstanceOf(NodeHttpHandler);
    expect(DYNAMO_TIMEOUTS.requestTimeoutMs).toBeLessThanOrEqual(2_000);
  });

  it("builds the DocumentClient with its retry budget and drops undefined attributes", async () => {
    const client = createDocumentClient();
    expect(await client.config.maxAttempts()).toBe(DYNAMO_TIMEOUTS.maxAttempts);
    expect(client.config.translateConfig?.marshallOptions).toMatchObject({ removeUndefinedValues: true, convertClassInstanceToMap: false });
    expect(dynamoDocumentClient()).toBe(dynamoDocumentClient());
  });
});
