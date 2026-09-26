// Faults per world (docs/architecture-integrations.md §5, point 4). The client sends
// `X-Fault-Scope: <clockId>` only for operations of a `qa-*` clock; the mock applies a fault only
// when that header names a `qa-*` clock that has a `CONFIG/FAULTS#<clockId>` row, so a scenario run
// never slows down or breaks the demo of a firm or a judge, whatever the header says.
import { parseClockId } from "@legajo/shared";
import { isLive, type CatalogStore, type FaultMode } from "./catalog";

/** LATENCY stays under the client's 8 s timeout; TIMEOUT answers after it has given up. */
export const FAULT_DELAYS_MS = { latency: 2_500, timeout: 10_000 } as const;

/** `Retry-After` of an injected 429 or 503, in seconds. */
export const FAULT_RETRY_AFTER_SECONDS = 1;

export type FaultEffect =
  | { readonly kind: "none" }
  /** Answer normally after the delay. */
  | { readonly kind: "delay"; readonly mode: FaultMode; readonly ms: number }
  /** Answer `status` (with `Retry-After`) after the delay, without reading anything. */
  | { readonly kind: "fail"; readonly mode: FaultMode; readonly status: 429 | 503; readonly ms: number };

const NONE: FaultEffect = { kind: "none" };

export interface FaultInputs {
  readonly catalog: CatalogStore;
  readonly now: Date;
  /** Uniform in [0, 1): a fault with `rate` r applies to about r of the calls. */
  readonly random: () => number;
}

export async function faultFor(scopeHeader: string | undefined, inputs: FaultInputs): Promise<FaultEffect> {
  if (scopeHeader === undefined || parseClockId(scopeHeader)?.scope !== "QA") return NONE;
  const item = await inputs.catalog.faults(scopeHeader);
  if (item === undefined || item.clockId !== scopeHeader || item.mode === "NONE") return NONE;
  if (!isLive(item, inputs.now) || Date.parse(item.until) <= inputs.now.getTime()) return NONE;
  if (inputs.random() >= item.rate) return NONE;
  switch (item.mode) {
    case "LATENCY":
      return { kind: "delay", mode: item.mode, ms: FAULT_DELAYS_MS.latency };
    case "ERROR_503":
      return { kind: "fail", mode: item.mode, status: 503, ms: 0 };
    case "ERROR_429":
      return { kind: "fail", mode: item.mode, status: 429, ms: 0 };
    case "TIMEOUT":
      return { kind: "fail", mode: item.mode, status: 503, ms: FAULT_DELAYS_MS.timeout };
  }
}
