// In-memory adapter: the same Connector and SeedStore code over a map, with an injected real clock
// and a deterministic id sequence so assertions are stable. The unit tests, the local flows
// (`tests/flows/support/world.ts`) and the local UI server build their world with it.
import { createConnector, type Connector } from "../connector";
import { createSeedStore } from "../dynamo/seed";
import type { RepoContext } from "../dynamo/repo";
import type { SeedStore } from "../ports-runtime";
import { MemoryTableClient } from "./table-client";

export interface MemoryStores {
  readonly client: MemoryTableClient;
  readonly connector: Connector;
  readonly seed: SeedStore;
  readonly ctx: RepoContext;
}

export interface MemoryStoresOptions {
  /** Real clock of the stamps (`createdAt`, TTLs); fixed in tests. */
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** `ID0000000001`, `ID0000000002`…: valid in every id pattern that embeds a generated id. */
export function sequentialIds(prefix = "ID"): () => string {
  let sequence = 0;
  return () => `${prefix}${(++sequence).toString().padStart(10, "0")}`;
}

export function createMemoryStores(options: MemoryStoresOptions = {}): MemoryStores {
  const client = new MemoryTableClient();
  const ctx: RepoContext = { client, now: options.now ?? (() => new Date()), newId: options.newId ?? sequentialIds() };
  return { client, ctx, connector: createConnector(ctx), seed: createSeedStore(client) };
}
