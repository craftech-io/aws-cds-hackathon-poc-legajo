// Neutral surfaces guard (ADR-0014 §2 to §6): no visible surface of the product (landing, sign-up and
// sign-in, console, legal pages, simulator, mailbox, upload page, emails, PDFs, WhatsApp templates,
// texts of the seed) contains a word of scripts/lint/neutral-words.ts. Needs no secret: it runs the
// same in CI, in forks and on a laptop. There is no list of exceptions: a legitimate text that
// collides is rewritten.
//
//   npm run lint:neutral-surfaces                              visible sources (ADR-0014 §4)
//   npm run lint:neutral-surfaces -- --dist                    packages/web/dist (after the web build)
//   npm run lint:neutral-surfaces -- --all-tree [--group <n>]  every versioned text file, one-off (not CI)
//
// Output: `path:line: word` per hit and exit 1; without hits, one line with the number of files and
// exit 0. Exit 2 on a usage error, on a missing or empty build in --dist mode (fails closed) and on a
// PDF that cannot be read.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pdfText } from "./forbidden-terms";
import { globToRegExp } from "./wp-ownership";
import { NEUTRAL_GROUP_NUMBERS, type NeutralHit, findNeutralHits } from "./neutral-words";

/** Text files of the visible sources (ADR-0014 §4); `.jsonl` is JSON too (seed metrics inputs). */
export const TEXT_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".mjs", ".css", ".html", ".json", ".jsonl", ".svg", ".txt", ".xml", ".webmanifest"];

/** Text files of the web build; a source map would carry the sources, so it is read too. */
export const DIST_EXTENSIONS: readonly string[] = [...TEXT_EXTENSIONS, ".map"];

/** Read with the same text and metadata extraction as `lint:forbidden`. */
export const PDF_EXTENSION = ".pdf";

/** ADR-0014 §4, one entry per row of the table. */
export const SOURCE_GLOBS: readonly string[] = [
  "packages/web/src/**",
  "packages/web/index.html",
  "packages/web/public/**",
  "packages/bff/src/copy/**",
  "packages/bff/src/public-web/**",
  "packages/bff/src/auth-triggers/messages/**",
  "packages/bff/src/leads/notice/**",
  "packages/reader-mock/src/**",
  "packages/platform-mock/src/**",
  "packages/shared/src/consent-texts.ts",
  "infra/auth-email.ts",
  "scripts/channels/whatsapp-templates.ts",
  "scripts/seed/data/**",
  "scripts/seed/pdfs/**",
];

/** Never read in sources mode (ADR-0014 §4). */
export const EXCLUDED_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/__snapshots__/**",
  "**/testing/**",
  "packages/web/e2e/**",
  "README.md",
  "docs/**",
  ".claude/**",
  "CLAUDE.md",
  "CONTEXT.md",
  ".github/**",
  "scripts/lint/**",
];

/** The only exclusions of --all-tree: the rename map that keeps the old names and the list itself. */
export const ALL_TREE_EXCLUDED_GLOBS: readonly string[] = ["docs/adr/0014-*", "scripts/lint/neutral-*"];

export const DIST_DIR = "packages/web/dist";

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git", ".sst"]);

const matcher = (globs: readonly string[]) => {
  const patterns = globs.map(globToRegExp);
  return (path: string): boolean => patterns.some((pattern) => pattern.test(path));
};

const inSourceGlob = matcher(SOURCE_GLOBS);
const isExcluded = matcher(EXCLUDED_GLOBS);
const isAllTreeExcluded = matcher(ALL_TREE_EXCLUDED_GLOBS);

function walk(root: string, dir: string, out: string[]): void {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return;
  if (!statSync(absolute).isDirectory()) {
    out.push(dir);
    return;
  }
  for (const entry of readdirSync(absolute)) if (!SKIPPED_DIRS.has(entry)) walk(root, dir === "" ? entry : `${dir}/${entry}`, out);
}

function literalDir(glob: string): string {
  const star = glob.indexOf("*");
  return star === -1 ? glob : glob.slice(0, star).replace(/\/$/, "");
}

const extensionOf = (path: string): string => extname(path).toLowerCase();

/** True when sources mode reads `path` (repository-relative): in a row of §4, a text file or a PDF, not excluded. */
export function isVisibleSource(path: string): boolean {
  const extension = extensionOf(path);
  if (!TEXT_EXTENSIONS.includes(extension) && extension !== PDF_EXTENSION) return false;
  return inSourceGlob(path) && !isExcluded(path);
}

/** Every file sources mode reads under `root`, sorted. */
export function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const dir of new Set(SOURCE_GLOBS.map(literalDir))) walk(root, dir, found);
  return [...new Set(found)].filter(isVisibleSource).sort();
}

/** Every text file of the web build, sorted; [] when the build is missing. */
export function distFiles(root: string): string[] {
  const found: string[] = [];
  if (existsSync(join(root, DIST_DIR))) walk(root, DIST_DIR, found);
  return found.filter((path) => DIST_EXTENSIONS.includes(extensionOf(path))).sort();
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** Every versioned (or new, not ignored) text file but the two exclusions, sorted. */
export function allTreeFiles(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return listed
    .split("\0")
    .filter((path) => path !== "" && !isAllTreeExcluded(path) && extensionOf(path) !== PDF_EXTENSION)
    .filter((path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile() && !isBinary(readFileSync(join(root, path))))
    .sort();
}

export interface FileHit extends NeutralHit {
  readonly path: string;
}

/** Hits of every file, in file and line order; PDFs are read by their text and metadata. */
export async function scanFiles(root: string, files: readonly string[], groups?: readonly number[]): Promise<FileHit[]> {
  const hits: FileHit[] = [];
  for (const path of files) {
    const bytes = readFileSync(join(root, path));
    const text = extensionOf(path) === PDF_EXTENSION ? await pdfText(bytes) : bytes.toString("utf8");
    for (const hit of findNeutralHits(text, groups)) hits.push({ path, ...hit });
  }
  return hits;
}

export type Mode = { readonly kind: "sources" } | { readonly kind: "dist" } | { readonly kind: "all-tree"; readonly groups?: readonly number[] };

/** The mode of the command line, or the reason it is not valid. */
export function parseArgs(argv: readonly string[]): Mode | { readonly error: string } {
  if (argv.length === 0) return { kind: "sources" };
  if (argv.length === 1 && argv[0] === "--dist") return { kind: "dist" };
  if (argv[0] !== "--all-tree") return { error: `unknown arguments: ${argv.join(" ")}` };
  if (argv.length === 1) return { kind: "all-tree" };
  const value = argv[2] ?? "";
  if (argv.length !== 3 || argv[1] !== "--group") return { error: "usage: --all-tree [--group <n>]" };
  const group = Number(value);
  if (String(group) !== value || !NEUTRAL_GROUP_NUMBERS.includes(group)) {
    return { error: `--group takes the number of a row of ADR-0014 §2 (${NEUTRAL_GROUP_NUMBERS.join(", ")})` };
  }
  return { kind: "all-tree", groups: [group] };
}

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const DESCRIPTION: Record<Mode["kind"], string> = {
  sources: "visible source file(s)",
  dist: `file(s) of ${DIST_DIR}`,
  "all-tree": "versioned text file(s)",
};

/** Runs one mode over `root` and returns the exit code (0 clean, 1 hits, 2 usage or fail-closed). */
export async function run(argv: readonly string[], root: string, io: Io): Promise<number> {
  const mode = parseArgs(argv);
  if ("error" in mode) {
    io.err(`neutral-surfaces: ${mode.error}`);
    return 2;
  }
  let files: string[];
  let hits: FileHit[];
  try {
    files = mode.kind === "sources" ? sourceFiles(root) : mode.kind === "dist" ? distFiles(root) : allTreeFiles(root);
    if (mode.kind === "dist" && files.length === 0) {
      io.err(`neutral-surfaces: ${DIST_DIR} is missing or has no text file; run \`npm run build -w packages/web\` first.`);
      return 2;
    }
    hits = await scanFiles(root, files, mode.kind === "all-tree" ? mode.groups : undefined);
  } catch (error) {
    io.err(`neutral-surfaces: the files could not be listed or read (${error instanceof Error ? error.message : String(error)})`);
    return 2;
  }
  if (hits.length > 0) {
    for (const hit of hits) io.err(`${hit.path}:${hit.line}: ${hit.word}`);
    const fileCount = new Set(hits.map((hit) => hit.path)).size;
    io.err(`neutral-surfaces: ${hits.length} hit(s) in ${fileCount} of ${files.length} ${DESCRIPTION[mode.kind]} (ADR-0014 §2; rewrite the text, there are no exceptions).`);
    return 1;
  }
  io.out(`neutral-surfaces: ${files.length} ${DESCRIPTION[mode.kind]} checked, no listed word.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), process.cwd(), { out: (line) => console.log(line), err: (line) => console.error(line) });
}
