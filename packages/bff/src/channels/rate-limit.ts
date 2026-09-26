// Messages per sender and simulated hour of a world (docs/architecture.md §13, FL-094):
// `Runtime/RATE#<clockId>#<addressHash>#<simHour>`, with `simHour` the world's simulated time truncated
// to the hour in UTC and the limit `settings.rateLimitPerHour` of the world's clock (20 by default).
// A delivery is admitted in this order: its provider id seen before → `DUPLICATE`, never counted (a
// retried webhook or a doubled tap does not eat the sender's quota); else the counter goes up by one,
// and past the limit → `RATE_LIMITED` (the adapter answers the fixed text and audits `DENY RATE_LIMIT`,
// no turn). A new simulated hour is a new counter.
import type { RuntimePort } from "../connector/ports-runtime";
import { SimHour } from "../domain/runtime";
import type { Clock } from "../domain/world-state";

/** Limit when the clock carries no setting (docs/architecture.md §13). */
export const DEFAULT_RATE_LIMIT_PER_HOUR = 20;

/** `2026-10-15T13` for any instant of that UTC hour. */
export function simHourOf(simNow: Date): string {
  if (Number.isNaN(simNow.getTime())) throw new RangeError("simHourOf needs a valid instant");
  return SimHour.parse(simNow.toISOString().slice(0, 13));
}

export function rateLimitOf(clock: Pick<Clock, "settings"> | undefined): number {
  return clock?.settings.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR;
}

export interface InboundDelivery {
  /** Idempotency source of the channel (`WHATSAPP`, `EMAIL`). */
  readonly source: string;
  /** Provider id of the delivery (`wamid`, `Message-ID`). */
  readonly id: string;
}

export interface AdmitInput {
  readonly delivery: InboundDelivery;
  readonly clockId: string;
  /** Keyed hash of the sender's address (`phoneHash`); never the address. */
  readonly addressHash: string;
  readonly simNow: Date;
  readonly limitPerHour: number;
  /** Real instant of the reception (the idempotency mark's stamp). */
  readonly atReal: string;
}

export type Admission =
  | { readonly outcome: "DUPLICATE" }
  | { readonly outcome: "ADMITTED" | "RATE_LIMITED"; readonly count: number; readonly limit: number; readonly simHour: string };

export async function admitInbound(runtime: Pick<RuntimePort, "claimIdempotency" | "incrementRate">, input: AdmitInput): Promise<Admission> {
  if (!Number.isInteger(input.limitPerHour) || input.limitPerHour < 1) throw new RangeError(`invalid rate limit ${input.limitPerHour}`);
  const first = await runtime.claimIdempotency({ source: input.delivery.source, id: input.delivery.id, atReal: input.atReal });
  if (!first) return { outcome: "DUPLICATE" };
  const simHour = simHourOf(input.simNow);
  const count = await runtime.incrementRate({ clockId: input.clockId, addressHash: input.addressHash, simHour });
  return { outcome: count > input.limitPerHour ? "RATE_LIMITED" : "ADMITTED", count, limit: input.limitPerHour, simHour };
}
