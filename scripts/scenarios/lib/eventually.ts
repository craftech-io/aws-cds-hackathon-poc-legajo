// Waits of the scenario runner (docs/test-plan.md §4.3), derived from the architecture: a turn is the
// Harness timeout + 60 s; an SES round trip is the outbound mail, `SimMail`, the inbound mail, the
// intake and the turn; the Scheduler step absorbs the lateness of `at()`. After the first full run
// each cap is set to p99 × 1.5 from `scenario-report.json`.

export const WAITS = {
  turnSec: 180,
  sesRoundTripSec: 300,
  schedulerSec: 240,
  settleSec: 300,
  memoryExtractionSec: 600,
  memoryPurgeSec: 120,
  readerSec: 20,
  dlqSec: 600,
  /** Transit of a platform event through the `Feeds` bus, which no pending item tracks. */
  feedTransitSec: 30,
} as const;

export interface EventuallyOptions {
  readonly timeoutSec: number;
  readonly everySec?: number;
  /** Real time, injected by the tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class WaitTimeout extends Error {
  override readonly name = "WaitTimeout";
  constructor(
    readonly what: string,
    readonly timeoutSec: number,
    readonly last: string | undefined,
  ) {
    super(`${what}: not reached within ${timeoutSec} s${last === undefined ? "" : ` (last: ${last})`}`);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `probe` until it returns something other than `undefined` or `false`. A probe that throws is
 * retried until the deadline, and its last error is reported with the timeout.
 */
export async function eventually<T>(what: string, probe: () => Promise<T | undefined | false>, options: EventuallyOptions): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.timeoutSec * 1_000;
  const every = (options.everySec ?? 5) * 1_000;
  let last: string | undefined;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
      last = undefined;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    const left = deadline - now();
    if (left <= 0) throw new WaitTimeout(what, options.timeoutSec, last);
    await sleep(Math.min(every, left));
  }
}
