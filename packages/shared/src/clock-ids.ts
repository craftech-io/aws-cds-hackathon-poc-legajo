// Clock ids (ADR-0007, docs/architecture.md §8): every operation belongs to the clock of its world.
//
//   GLOBAL#<firmId>          demo world of a firm (also GLOBAL#firm-qa, the minimal QA world)
//   GUEST#<firmId>           a guest's own world (and GUEST#firm-guest-test)
//   qa-<runId>-<scenario>    ephemeral world of the scenario runner
//   sim-<batchId>            world of the metrics batch
import { z } from "zod";
import { FirmId, isId } from "./ids";

export const ClockScope = z.enum(["GLOBAL", "GUEST", "QA", "SIM"]);
export type ClockScope = z.infer<typeof ClockScope>;

const TOKEN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export const ClockId = z.string().refine((value) => parseClockId(value) !== undefined, "expected GLOBAL#<firmId>, GUEST#<firmId>, qa-<runId>-<scenario> or sim-<batchId>");
export type ClockId = z.infer<typeof ClockId>;

export interface ParsedClockId {
  readonly scope: ClockScope;
  /** Firm of a GLOBAL or GUEST clock; QA and batch clocks live in `firm-qa` / `firm-sim`. */
  readonly firmId?: FirmId;
}

export function parseClockId(value: string): ParsedClockId | undefined {
  const hash = value.indexOf("#");
  if (hash !== -1) {
    const scope = value.slice(0, hash);
    const firmId = value.slice(hash + 1);
    if ((scope === "GLOBAL" || scope === "GUEST") && isId("firm", firmId)) return { scope, firmId };
    return undefined;
  }
  if (value.startsWith("qa-") && TOKEN.test(value.slice(3))) return { scope: "QA" };
  if (value.startsWith("sim-") && TOKEN.test(value.slice(4))) return { scope: "SIM" };
  return undefined;
}

export function clockScopeOf(clockId: string): ClockScope {
  const parsed = parseClockId(clockId);
  if (parsed === undefined) throw new RangeError(`invalid clock id "${clockId}"`);
  return parsed.scope;
}

export function globalClockId(firmId: string): ClockId {
  return `GLOBAL#${FirmId.parse(firmId)}`;
}

export function guestClockId(firmId: string): ClockId {
  return `GUEST#${FirmId.parse(firmId)}`;
}

/** `qa-<runId>-<scenario>`, e.g. `qa-812-1-sc16` or `qa-812-1-sc18-rate`. */
export function qaClockId(runId: string, scenario: string): ClockId {
  return ClockId.parse(`qa-${runId}-${scenario}`);
}

export function simClockId(batchId: string): ClockId {
  return ClockId.parse(`sim-${batchId}`);
}

/**
 * Firms of QA type (ADR-0005): every mutating action of the `QaDriver` needs one of them, and a clock
 * that is `qa-*` or one of the two fixed QA clocks below.
 */
export const QA_FIRM_IDS: readonly FirmId[] = ["firm-qa", "firm-sim", "firm-guest-test"];

/** Minimal QA world that `SC-20` resets; only a closed list of `QaDriver` actions reaches it. */
export const QA_GLOBAL_CLOCK_ID: ClockId = "GLOBAL#firm-qa";

/** World of the synthetic guest account of `SC-24` and `SC-25`. */
export const GUEST_TEST_CLOCK_ID: ClockId = "GUEST#firm-guest-test";
