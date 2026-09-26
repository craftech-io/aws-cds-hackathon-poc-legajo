// In-memory `ReaderCatalog`: the unit tests of the mock and of the BFF client, and the local flows
// (tests/flows, "lector y plataforma mock en proceso") run the real reader app on it.
import { catalogKeys, isLive, type CatalogStore, type FaultItem, type GroundTruthItem, type GroundTruthReading, type IdempotencyItem } from "./catalog";

export interface MemoryCatalog extends CatalogStore {
  /** Loads ground-truth items (the output of `groundTruthItems`, or the seed's ReaderCatalog.json). */
  load(items: readonly GroundTruthItem[]): void;
  setFaults(item: FaultItem): void;
  clearFaults(clockId: string): void;
  /** Number of cached readings, for assertions. */
  cachedCount(): number;
}

export function createMemoryCatalog(items: readonly GroundTruthItem[] = []): MemoryCatalog {
  const truths = new Map<string, GroundTruthReading>();
  const faults = new Map<string, FaultItem>();
  const cache = new Map<string, IdempotencyItem>();

  const catalog: MemoryCatalog = {
    load(loaded) {
      for (const item of loaded) truths.set(item.PK, structuredClone(item.reading));
    },
    setFaults(item) {
      faults.set(item.SK, structuredClone(item));
    },
    clearFaults(clockId) {
      faults.delete(catalogKeys.faults(clockId));
    },
    cachedCount: () => cache.size,
    async groundTruth(key) {
      const pk = "sha256" in key ? catalogKeys.sha(key.sha256) : catalogKeys.docId(key.docId);
      const found = truths.get(pk);
      return found === undefined ? undefined : structuredClone(found);
    },
    async faults(clockId) {
      const found = faults.get(catalogKeys.faults(clockId));
      return found === undefined ? undefined : structuredClone(found);
    },
    async cachedReading(idempotencyKey, sha256, now) {
      const found = cache.get(catalogKeys.idempotency(idempotencyKey, sha256));
      return found !== undefined && isLive(found, now) ? structuredClone(found) : undefined;
    },
    async cacheReading(item) {
      const existing = cache.get(item.PK);
      if (existing !== undefined && isLive(existing, new Date(item.createdAt))) return structuredClone(existing);
      cache.set(item.PK, structuredClone(item));
      return structuredClone(item);
    },
  };
  catalog.load(items);
  return catalog;
}
