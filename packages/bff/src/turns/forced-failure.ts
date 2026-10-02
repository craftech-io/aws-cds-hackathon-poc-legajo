// `turn.forceFailure` of the QaDriver (FL-097, `SC-19/5`): the next turn of an operation of a scenario
// world fails as if the Harness had timed out, so the deterministic fallback of the first request runs
// against the real stage. The request is a `Runtime/PROBE#` row (48-hour TTL) the driver writes and the
// worker consumes once, before invoking the Harness; outside `qa-*` worlds it is never read.
import { parseClockId } from "@legajo/shared";
import type { RuntimePort } from "../connector/index";

export const FORCED_FAILURE_KIND = "FORCE_TURN_FAILURE";

export function forcedFailureProbeId(operationId: string): string {
  return `force-turn-failure-${operationId}`;
}

type Probes = Pick<RuntimePort, "getProbe" | "putProbe">;

/** QaDriver side (`turn.forceFailure`): the next turn of `operationId` fails. */
export async function requestForcedFailure(runtime: Probes, input: { readonly operationId: string; readonly clockId: string; readonly atReal: string }): Promise<void> {
  if (parseClockId(input.clockId)?.scope !== "QA") throw new RangeError("a forced turn failure only exists in qa-* worlds");
  await runtime.putProbe({ probeId: forcedFailureProbeId(input.operationId), kind: FORCED_FAILURE_KIND, ok: false, detail: { state: "REQUESTED", clockId: input.clockId }, atReal: input.atReal });
}

/** Worker side: true once per request, only in `qa-*` worlds (the operation's events run one at a time). */
export async function takeForcedFailure(runtime: Probes, input: { readonly operationId: string; readonly clockId: string; readonly turnId: string; readonly atReal: string }): Promise<boolean> {
  if (parseClockId(input.clockId)?.scope !== "QA") return false;
  const probe = await runtime.getProbe(forcedFailureProbeId(input.operationId));
  if (probe === undefined || probe.kind !== FORCED_FAILURE_KIND || probe.detail["state"] !== "REQUESTED") return false;
  await runtime.putProbe({ probeId: probe.probeId, kind: FORCED_FAILURE_KIND, ok: true, detail: { state: "CONSUMED", clockId: input.clockId, turnId: input.turnId }, atReal: input.atReal });
  return true;
}
