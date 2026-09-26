// Matches the Cognito `sub` of a console user with its broker row (`Firms/BROKER#…`, GSI1
// `cognitoSubKey`, docs/architecture.md §5). The row gives the `brokerId` that signs the audit log,
// the role and the `active` switch: an id token lives 15 minutes and is verified offline, so
// deactivating a broker or taking away its approval rights must not wait for the token to expire.
import type { ConsoleRole } from "@legajo/shared";
import type { FirmsPort } from "../connector/ports";

export interface BrokerMatch {
  readonly brokerId: string;
  readonly role: ConsoleRole;
  readonly active: boolean;
}

/** What the directory needs from the connector. */
export interface BrokerLookup {
  /** `undefined` when no broker row of the firm names this `sub`. */
  findBySub(firmId: string, sub: string): Promise<BrokerMatch | undefined>;
}

/** The lookup over `Firms` (the pre-token trigger and the BFF read the same rows). */
export function brokerLookupOf(firms: Pick<FirmsPort, "findBrokerBySub">): BrokerLookup {
  return {
    async findBySub(firmId, sub) {
      const broker = await firms.findBrokerBySub(firmId, sub);
      return broker === undefined ? undefined : { brokerId: broker.brokerId, role: broker.role, active: broker.active };
    },
  };
}

export interface BrokerDirectory {
  find(firmId: string, sub: string): Promise<BrokerMatch | undefined>;
}

// One read per user per minute per container instead of one per request.
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  readonly expiresAt: number;
  readonly match: BrokerMatch | undefined;
}

export function createBrokerDirectory(lookup: BrokerLookup, now: () => Date = () => new Date(), ttlMs: number = DEFAULT_TTL_MS): BrokerDirectory {
  const cache = new Map<string, CacheEntry>();

  return {
    async find(firmId, sub) {
      const key = `${firmId}#${sub}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now().getTime()) return cached.match;

      const match = await lookup.findBySub(firmId, sub);
      cache.set(key, { expiresAt: now().getTime() + ttlMs, match });
      return match;
    },
  };
}
