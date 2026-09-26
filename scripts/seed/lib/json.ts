// Canonical JSON of the seed (docs/seed-spec.md §1, "Determinismo"): keys sorted at every level,
// two-space indentation, one trailing newline, no `undefined` members. Two generations of the same
// seed write the same bytes, whatever order the generator built an object in.
import { createHash } from "node:crypto";

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = sortDeep(member);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError("the seed never writes NaN or Infinity");
  return value;
}

/** Pretty canonical JSON with a final newline. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

/** One canonical JSON object per line (`metrics/batch-inputs.jsonl`). */
export function stableJsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(sortDeep(value))).join("\n") + "\n";
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
