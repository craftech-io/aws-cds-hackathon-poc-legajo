// docs/seed-spec.md §1, "Determinismo": two runs of the generator in separate processes write the same
// bytes, and those bytes are the committed seed (a diff in data/ or pdfs/ without a change in
// generate/ is an error). The generator uses no Intl nor toLocale* (the same scan as `npm run lint`).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findIntlUsages } from "../../lint/no-intl";
import { REPO_ROOT, SEED_ROOT } from "../lib/constants";
import { stableJsonLines, stableStringify } from "../lib/json";

const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const scratch: string[] = [];

function files(dir: string, root: string = dir, out: Map<string, Buffer> = new Map()): Map<string, Buffer> {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, root, out);
    else out.set(relative(root, path), readFileSync(path));
  }
  return out;
}

function seedFiles(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const dir of ["data", "pdfs"]) for (const [path, bytes] of files(join(root, dir))) out.set(`${dir}/${path}`, bytes);
  return out;
}

/** A fresh generation in its own Node process. */
function generateInProcess(): string {
  const root = mkdtempSync(join(tmpdir(), "legajo-seed-"));
  scratch.push(root);
  execFileSync(TSX, [join(SEED_ROOT, "generate.ts"), "--out", root], { cwd: REPO_ROOT, stdio: "pipe", env: { ...process.env, FORBIDDEN_TERMS: "" } });
  return root;
}

function differences(a: ReadonlyMap<string, Buffer>, b: ReadonlyMap<string, Buffer>): string[] {
  const paths = new Set([...a.keys(), ...b.keys()]);
  return [...paths].filter((path) => a.get(path)?.equals(b.get(path) ?? Buffer.alloc(0)) !== true).sort();
}

afterAll(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true });
});

describe("seed determinism", () => {
  it("writes the same bytes in two separate processes, and they are the committed seed", () => {
    const first = seedFiles(generateInProcess());
    const second = seedFiles(generateInProcess());
    expect(first.size).toBeGreaterThan(100);
    expect(differences(first, second)).toEqual([]);
    expect(differences(first, seedFiles(SEED_ROOT))).toEqual([]);
  }, 240_000);

  it("uses neither Intl nor toLocale* in the generator", () => {
    const generator = files(join(SEED_ROOT, "generate"));
    expect(generator.size).toBeGreaterThan(10);
    const usages = [...generator].flatMap(([path, bytes]) => findIntlUsages(path, bytes.toString("utf8")));
    expect(usages).toEqual([]);
  });

  it("serializes JSON with sorted keys, whatever order an object was built in", () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(stableStringify({ a: { d: [2, { y: 2, z: 1 }] }, b: 1 }));
    expect(stableJsonLines([{ b: 1, a: 2 }])).toBe('{"a":2,"b":1}\n');
    expect(() => stableStringify({ a: Number.NaN })).toThrow(RangeError);
  });
});
