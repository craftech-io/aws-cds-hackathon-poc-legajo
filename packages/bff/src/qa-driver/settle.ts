// `op.settle` (docs/tool-catalog.md, docs/architecture.md §7): the quiescence every negative or exact
// count of a scenario waits for. An operation is quiet when its `OPSTATE#.inFlight` is empty, none of
// its timers is due at the world's simulated now, and its clock has no open pending mail or scan (a
// mail counts until its receiver processed it, not until SES delivered it). The driver returns once
// the operation stays quiet for 10 real seconds, and fails at the deadline naming what is pending.
// A pending item past its stale mark is reported, not waited for.
import { ToolError } from "@legajo/shared";
import type { Connector } from "../connector/index";
import { simNowOf } from "../lib/clock";
import { QA_REASON } from "./contract";

/** Real seconds the operation has to stay quiet (docs/test-plan.md §4.3). */
export const SETTLE_HOLD_MS = 10_000;
export const SETTLE_POLL_MS = 2_000;

export interface Pending {
  readonly kind: "EVENT" | "TIMER" | "MAIL" | "SCAN";
  /** Event id, timer key, what the mail waits for, or the bucket of a scan: never an address. */
  readonly detail: string;
}

export interface QuietCheck {
  readonly pending: readonly Pending[];
  readonly stale: readonly Pending[];
  readonly simNow: string;
}

export interface SettleDeps {
  readonly data: Pick<Connector, "operations" | "timers" | "world">;
  /** Real time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

/** One look at the operation and its world: what is still in flight, due or in transit. */
export async function quietCheck(deps: SettleDeps, operationId: string): Promise<QuietCheck> {
  const operation = await deps.data.operations.getOperation(operationId);
  const realNow = deps.now();
  const [clock, state, lists] = await Promise.all([deps.data.world.getClock(operation.clockId), deps.data.world.getOpState(operationId), deps.data.world.listPending(operation.clockId)]);
  const simNow = simNowOf(clock, realNow.getTime()).toISOString();
  const due = await deps.data.timers.listDueTimers(operation.clockId, simNow);
  const nowMs = realNow.getTime();
  const pending: Pending[] = [
    ...(state?.inFlight ?? []).map((eventId): Pending => ({ kind: "EVENT", detail: eventId })),
    ...due.filter((timer) => timer.operationId === operationId).map((timer): Pending => ({ kind: "TIMER", detail: `TIMER#${timer.kind}#${timer.timerId}` })),
  ];
  const stale: Pending[] = [];
  for (const mail of lists.mails) (Date.parse(mail.staleAtReal) <= nowMs ? stale : pending).push({ kind: "MAIL", detail: `${mail.awaiting} ${mail.mailId}` });
  for (const scan of lists.scans) (Date.parse(scan.staleAtReal) <= nowMs ? stale : pending).push({ kind: "SCAN", detail: `${scan.bucket} ${scan.scanKey}` });
  return { pending, stale, simNow };
}

export interface Settled {
  readonly settled: true;
  /** Real seconds the call waited in total. */
  readonly waitedSec: number;
  readonly simNow: string;
  readonly stale: readonly Pending[];
}

function describe(pending: readonly Pending[]): string {
  return pending.map((item) => `${item.kind} ${item.detail}`).join("; ");
}

/** Waits until the operation is quiet for `SETTLE_HOLD_MS`; NOT_SETTLED past `timeoutSec`. */
export async function settleOperation(deps: SettleDeps, input: { readonly operationId: string; readonly timeoutSec: number }): Promise<Settled> {
  const started = deps.now().getTime();
  const deadline = started + input.timeoutSec * 1_000;
  let quietSince: number | undefined;
  for (;;) {
    const check = await quietCheck(deps, input.operationId);
    const at = deps.now().getTime();
    if (check.pending.length === 0) {
      quietSince ??= at;
      if (at - quietSince >= SETTLE_HOLD_MS) return { settled: true, waitedSec: Math.round((at - started) / 1_000), simNow: check.simNow, stale: check.stale };
    } else {
      quietSince = undefined;
    }
    if (at >= deadline) {
      const what = check.pending.length === 0 ? "it was not quiet long enough" : describe(check.pending);
      throw new ToolError("UNAVAILABLE", `${input.operationId} is still busy after ${input.timeoutSec} s: ${what}`, QA_REASON.NOT_SETTLED);
    }
    await deps.sleep(Math.min(SETTLE_POLL_MS, Math.max(1, deadline - at)));
  }
}
