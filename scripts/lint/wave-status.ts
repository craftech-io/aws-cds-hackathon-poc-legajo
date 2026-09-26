// Keeps §5 "Estado de las olas" of docs/build-plan.md honest: a wave may be declared `aceptada` only
// when the plan's own entry rule holds for it (§"Reglas del plan": the previous wave merged, deployed
// by CI and smoke-green), so a later wave is never called done on top of waves that were never built.
//
// A wave is blocked (and therefore can only be `no aceptada` or `no iniciada`) when any of these holds:
//   1. an earlier wave is not `aceptada`;
//   2. a file or directory its WPs list under "Archivos:" does not exist (a glob needs one file);
//   3. a file its WPs own still carries a pending marker: `it.todo`/`test.todo`, `test.fixme`, a WP-02
//      infra stub, or production code that defaults to an unwired port (`= unwiredPorts()`);
//   4. nothing was ever deployed: `sst-env.d.ts` still declares an empty `Resource`.
//
//   npm run lint   (runs max-lines, no-intl, then this)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_FILE, type Wave, globToRegExp, parsePlan } from "./wp-ownership";

export const STATUS_HEADING = "## 5. Estado de las olas";
export const SST_ENV_FILE = "sst-env.d.ts";
export const WAVE_STATES = ["aceptada", "no aceptada", "no iniciada"] as const;
export type WaveState = (typeof WAVE_STATES)[number];

export interface WaveStatus {
  readonly wave: number;
  readonly state: WaveState;
}

/** Read-only view of the repository, so the rules run the same over the disk and over a fixture. */
export interface RepoView {
  exists(path: string): boolean;
  /** Every file under `dir` (recursive, repository-relative), or [] when it does not exist. */
  filesUnder(dir: string): string[];
  read(path: string): string;
}

interface Marker {
  readonly name: string;
  readonly pattern: RegExp;
  readonly productionOnly: boolean;
  /** The WP-02 stub header is a comment by design; every other marker only counts in code. */
  readonly inComments: boolean;
}

export const PENDING_MARKERS: readonly Marker[] = [
  { name: "it.todo", pattern: /\b(?:it|test)\.todo\(/g, productionOnly: false, inComments: false },
  { name: "test.fixme", pattern: /\btest\.fixme\(/g, productionOnly: false, inComments: false },
  { name: "WP-02 stub", pattern: /Stub created by WP-\d+/g, productionOnly: false, inComments: true },
  { name: "unwired default", pattern: /(?:=|\?\?|:)\s*unwired\w*\(\)/g, productionOnly: true, inComments: false },
];

const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

export function waveNumber(title: string): number | undefined {
  const match = /^Ola (\d+)\b/.exec(title);
  return match ? Number(match[1]) : undefined;
}

/** Rows `| Ola N | \`estado\` | … |` of §5; an unknown state is returned as-is for `violations`. */
export function parseStatus(markdown: string): { wave: number; state: string }[] {
  const start = markdown.indexOf(STATUS_HEADING);
  if (start === -1) return [];
  const end = markdown.indexOf("\n## ", start + STATUS_HEADING.length);
  const section = markdown.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/^\|\s*Ola (\d+)\s*\|\s*`([^`]+)`\s*\|/gm)].map((match) => ({ wave: Number(match[1]), state: match[2] ?? "" }));
}

/** True once a deploy regenerated `sst-env.d.ts` with at least one linked resource. */
export function deployed(sstEnv: string): boolean {
  const body = /interface Resource\s*\{([\s\S]*?)\n?\s*\}/.exec(sstEnv)?.[1];
  return body !== undefined && body.trim() !== "";
}

function literalDir(pattern: string): string {
  const star = pattern.indexOf("*");
  const prefix = star === -1 ? pattern : pattern.slice(0, star);
  return prefix.replace(/\/[^/]*$/, "");
}

/** Files a WP pattern owns today (a literal path yields itself when it exists). */
export function ownedFiles(pattern: string, repo: RepoView): string[] {
  if (!pattern.includes("*")) {
    if (!repo.exists(pattern)) return [];
    const nested = repo.filesUnder(pattern);
    return nested.length > 0 ? nested : [pattern];
  }
  const glob = globToRegExp(pattern);
  return repo.filesUnder(literalDir(pattern)).filter((file) => glob.test(file));
}

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** Pending markers of `source`, ignoring comment lines (a rule that only names a marker is not one). */
export function markersIn(file: string, source: string): string[] {
  const code = source
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");
  const found: string[] = [];
  for (const marker of PENDING_MARKERS) {
    if (marker.productionOnly && TEST_FILE.test(file)) continue;
    const count = (marker.inComments ? source : code).match(marker.pattern)?.length ?? 0;
    if (count > 0) found.push(`${count} × ${marker.name}`);
  }
  return found;
}

/** Why each wave of the plan cannot be accepted yet (an empty list means it may be). */
export function blockers(waves: readonly Wave[], statuses: readonly WaveStatus[], repo: RepoView): Map<number, string[]> {
  const stateOf = new Map(statuses.map((status) => [status.wave, status.state]));
  const isDeployed = repo.exists(SST_ENV_FILE) && deployed(repo.read(SST_ENV_FILE));
  const result = new Map<number, string[]>();
  for (const wave of waves) {
    const number = waveNumber(wave.title);
    if (number === undefined) continue;
    const reasons: string[] = [];
    for (const earlier of waves) {
      const earlierNumber = waveNumber(earlier.title);
      if (earlierNumber !== undefined && earlierNumber < number && stateOf.get(earlierNumber) !== "aceptada") reasons.push(`ola ${earlierNumber} no aceptada`);
    }
    for (const pkg of wave.packages) {
      for (const pattern of pkg.files) {
        const files = ownedFiles(pattern, repo);
        if (files.length === 0) {
          reasons.push(`${pkg.id}: ${pattern} no existe`);
          continue;
        }
        for (const file of files) {
          const found = markersIn(file, repo.read(file));
          if (found.length > 0) reasons.push(`${pkg.id}: ${file}: ${found.join(", ")}`);
        }
      }
    }
    if (!isDeployed) reasons.push(`sin deploy por CI (${SST_ENV_FILE} sin recursos)`);
    result.set(number, [...new Set(reasons)]);
  }
  return result;
}

/** Errors in §5: missing or unknown rows, and any `aceptada` wave that still has blockers. */
export function violations(waves: readonly Wave[], markdown: string, repo: RepoView): string[] {
  const rows = parseStatus(markdown);
  const errors: string[] = [];
  const numbers = waves.map((wave) => waveNumber(wave.title)).filter((n): n is number => n !== undefined);
  for (const row of rows) {
    if (!(WAVE_STATES as readonly string[]).includes(row.state)) errors.push(`ola ${row.wave}: estado desconocido "${row.state}"`);
    if (!numbers.includes(row.wave)) errors.push(`ola ${row.wave}: no existe en §2`);
  }
  for (const number of numbers) {
    const count = rows.filter((row) => row.wave === number).length;
    if (count !== 1) errors.push(`ola ${number}: ${count} fila(s) en ${STATUS_HEADING}, se espera 1`);
  }
  const statuses = rows.filter((row): row is WaveStatus => (WAVE_STATES as readonly string[]).includes(row.state));
  const blocked = blockers(waves, statuses, repo);
  for (const status of statuses) {
    const reasons = blocked.get(status.wave) ?? [];
    if (status.state === "aceptada" && reasons.length > 0) {
      errors.push(`ola ${status.wave} declarada aceptada con ${reasons.length} bloqueo(s): ${reasons.slice(0, 5).join("; ")}`);
    }
  }
  return errors;
}

export function diskRepo(root: string): RepoView {
  const walk = (path: string, out: string[]): void => {
    let stats;
    try {
      stats = statSync(join(root, path));
    } catch {
      return;
    }
    if (!stats.isDirectory()) {
      out.push(path);
      return;
    }
    for (const entry of readdirSync(join(root, path))) if (entry !== "node_modules" && entry !== "dist") walk(path === "" ? entry : `${path}/${entry}`, out);
  };
  return {
    exists: (path) => existsSync(join(root, path)),
    filesUnder: (dir) => {
      if (!existsSync(join(root, dir)) || !statSync(join(root, dir)).isDirectory()) return [];
      const out: string[] = [];
      walk(dir, out);
      return out;
    },
    read: (path) => readFileSync(join(root, path), "utf8"),
  };
}

function main(): void {
  const cwd = process.cwd();
  const markdown = readFileSync(resolve(cwd, PLAN_FILE), "utf8");
  const waves = parsePlan(markdown);
  const repo = diskRepo(cwd);
  const errors = violations(waves, markdown, repo);
  if (errors.length > 0) {
    console.error(`wave-status: ${errors.length} error(s) in ${PLAN_FILE} ${STATUS_HEADING}:`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const statuses = parseStatus(markdown).filter((row): row is WaveStatus => (WAVE_STATES as readonly string[]).includes(row.state));
  const blocked = blockers(waves, statuses, repo);
  for (const status of statuses) console.log(`wave-status: ola ${status.wave} ${status.state} (${blocked.get(status.wave)?.length ?? 0} bloqueo(s))`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
