/// <reference path="../../../sst-env.d.ts" />
// Lambda entry of `PlatformMock` (Function URL with AWS_IAM, infra/mocks.ts): the table `Platform` and
// the bus `Feeds` come linked through `Resource` (never `process.env`), and each AWS client carries
// its own timeouts and the SDK's retries with exponential backoff and jitter.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { z } from "zod";
import { createDynamoPlatformStore } from "./dynamo-store";
import { newPlatformEventId } from "./events";
import { createFunctionUrlHandler } from "./lambda";
import { stdoutSink } from "./log";
import { createEventBridgePublisher } from "./publisher";

// DynamoDB answers in milliseconds and EventBridge in tens of them: past these budgets it is an
// outage, the caller gets a 503 and retries with the same Idempotency-Key.
const DYNAMO_CLIENT = { maxAttempts: 3, requestHandler: { requestTimeout: 2_000, connectionTimeout: 1_000 } };
const EVENTS_CLIENT = { maxAttempts: 3, requestHandler: { requestTimeout: 3_000, connectionTimeout: 1_000 } };

const LinkedName = z.object({ name: z.string().min(1) });

/** Physical name of a linked resource; `Resource` throws when it is not linked to this function. */
function linkedName(logicalName: "Platform" | "Feeds"): string {
  return LinkedName.parse(Reflect.get(Resource, logicalName)).name;
}

export const handler = createFunctionUrlHandler(() => {
  const now = () => new Date();
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient(DYNAMO_CLIENT), { marshallOptions: { removeUndefinedValues: true } });
  return {
    store: createDynamoPlatformStore({ client: documents, tableName: linkedName("Platform") }),
    publisher: createEventBridgePublisher({ client: new EventBridgeClient(EVENTS_CLIENT), busName: linkedName("Feeds") }),
    now,
    newEventId: () => newPlatformEventId(now().getTime()),
    log: stdoutSink,
  };
});
