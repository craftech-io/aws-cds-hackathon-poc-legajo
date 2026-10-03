// The two external mocks as the `QaDriver` reaches them with its own role (docs/architecture.md §14:
// `MOCK_PLATFORM`, `MOCK_READER`; docs/architecture-integrations.md §5-§6):
//
//   platform.get          GET  /v1/operations/{n}?firm=            (read only; QA firms)
//   feed.eta, feed.customs POST /v1/operations/{n}/eta | customs-status, `Idempotency-Key` = the step's key
//   probe.mocks           GET  /v1/health of both mocks (the health checks the console uses)
//   reader.setFaults      `ReaderCatalog` CONFIG / FAULTS#<clockId> built by the reader mock's own item builder
//
// SigV4 on the Function URLs (reader/signer.ts), with timeout and backoff on every call; the platform
// through its one client (services/operations-admin/platform.ts).
import { z } from "zod";
import { type FaultConfigInput, faultItem } from "@legajo/reader-mock/catalog";
import { type Item, tableClient } from "../connector/index";
import { readLinked } from "../lib/resource";
import { type RequestSigner, sigV4Signer } from "../reader/signer";
import { functionUrlHealthCheck } from "../routers/health";
import { type PlatformOperations, createPlatformClient } from "../services/operations-admin/platform";

const FunctionUrlLink = z.object({ url: z.url() });
const TIMEOUT_MS = 5_000;

export interface MocksDeps {
  readonly platformUrl?: () => string;
  readonly readerUrl?: () => string;
  readonly sign?: RequestSigner;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The platform client of services/operations-admin/platform.ts (the one client), with the driver's role. */
export function platformClient(deps: MocksDeps = {}): PlatformOperations {
  return createPlatformClient({
    endpoint: deps.platformUrl ?? (() => readLinked("PlatformMock", FunctionUrlLink).url),
    sign: deps.sign ?? sigV4Signer(),
    timeoutMs: TIMEOUT_MS,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
}

export type PlatformClient = PlatformOperations;

/** `GET /v1/health` of both mocks with the driver's role: `ok` or `unavailable` each. */
export function mocksHealth(deps: MocksDeps = {}) {
  const sign = deps.sign ?? sigV4Signer();
  const check = (name: string, endpoint: () => string) =>
    functionUrlHealthCheck({ name, endpoint, sign, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  const checks = [
    check("reader", deps.readerUrl ?? (() => readLinked("ReaderMock", FunctionUrlLink).url)),
    check("platform", deps.platformUrl ?? (() => readLinked("PlatformMock", FunctionUrlLink).url)),
  ];
  return async (): Promise<Record<string, "ok" | "unavailable">> => {
    const results = await Promise.all(
      checks.map(async (probe) => {
        try {
          await probe.run();
          return [probe.name, "ok"] as const;
        } catch {
          return [probe.name, "unavailable"] as const;
        }
      }),
    );
    return Object.fromEntries(results);
  };
}

/** Writes the faults of one `qa-*` world into `ReaderCatalog` (through the connector's table client); the builder refuses any other clock. */
export function readerFaultWriter(options: { readonly put?: (item: Item) => Promise<void> } = {}) {
  const put = options.put ?? ((item: Item) => tableClient().put("ReaderCatalog", item));
  return async (clockId: string, config: FaultConfigInput, now: Date) => {
    const item = faultItem(clockId, config, now);
    await put(item);
    return { clockId, mode: item.mode, rate: item.rate, until: item.until };
  };
}
