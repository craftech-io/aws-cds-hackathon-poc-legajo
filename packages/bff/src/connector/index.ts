// The only place that instantiates the DynamoDB adapter (docs/build-plan.md §1). Lambdas call
// `connector()`; tests and local flows call `createMemoryStores()`. Nothing outside connector/ (and
// lib/clients.ts) imports @aws-sdk/lib-dynamodb: tools, handlers and routers see only the ports.
import { ulid } from "../lib/crypto";
import { dynamoDocumentClient } from "../lib/clients";
import { createConnector, type Connector } from "./connector";
import { DynamoTableClient } from "./dynamo/client";
import type { RepoContext } from "./dynamo/repo";
import { createSeedStore } from "./dynamo/seed";
import type { SeedStore } from "./ports-runtime";
import type { TableClient } from "./table-client";

export type { Connector } from "./connector";
export type * from "./ports";
export type * from "./ports-runtime";
export type { Item, Key, TableClient, WriteCondition } from "./table-client";
export { createMemoryStores, sequentialIds, type MemoryStores } from "./memory/index";
export { QA_DELETE_CONDITION } from "./world-conditions";

export interface ConnectorOptions {
  /** Real clock of the stamps; `systemClock` in the Lambdas, fixed in tests. */
  readonly now?: () => Date;
}

let context: RepoContext | undefined;
let connectorInstance: Connector | undefined;
let seedInstance: SeedStore | undefined;

function repoContext(options: ConnectorOptions): RepoContext {
  if (!context || options.now) {
    const now = options.now ?? (() => new Date());
    context = { client: new DynamoTableClient(dynamoDocumentClient()), now, newId: () => ulid(now().getTime()) };
  }
  return context;
}

/** The DynamoDB connector (one per Lambda container). */
export function connector(options: ConnectorOptions = {}): Connector {
  if (!connectorInstance || options.now) connectorInstance = createConnector(repoContext(options));
  return connectorInstance;
}

/** Seed loader and world factory (`scripts/seed/load.ts`, `worlds/`, WP-31). */
export function seedStore(): SeedStore {
  seedInstance ??= createSeedStore(repoContext({}).client);
  return seedInstance;
}

/** Raw table access for the world factory's bulk writes and conditional deletes (WP-31, WP-37). */
export function tableClient(): TableClient {
  return repoContext({}).client;
}

/** Test seam: forget the singletons so a new clock or client takes effect. */
export function resetConnector(): void {
  context = undefined;
  connectorInstance = undefined;
  seedInstance = undefined;
}
