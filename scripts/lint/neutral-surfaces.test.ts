// ADR-0014 §5. This file and scripts/lint/neutral-words.ts are the only places, besides ADR-0014 itself,
// where the listed words and their variants are written: both are outside every scan by their path.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePdf } from "../seed/lib/pdf";
import { globToRegExp } from "./wp-ownership";
import { ALL_TREE_EXCLUDED_GLOBS, EXCLUDED_GLOBS, type Io, SOURCE_GLOBS, isVisibleSource, parseArgs, run, sourceFiles } from "./neutral-surfaces";
import { NEUTRAL_GROUPS, NEUTRAL_PHRASE, NEUTRAL_WORDS, findNeutralHits } from "./neutral-words";

const REPO = resolve(import.meta.dirname, "../..");
const ADR = "docs/adr/0014-superficies-neutrales-y-rol-invitado.md";

const groupOf = (word: string): number => NEUTRAL_GROUPS.find((entry) => entry.terms.includes(word))?.group ?? 0;
const capital = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
const ACUTE: Readonly<Record<string, string>> = { a: "á", e: "é", i: "í", o: "ó", u: "ú" };
const withAccent = (word: string): string => word.replace(/[aeiou]/, (vowel) => ACUTE[vowel] ?? vowel);
/** The spelling Spanish actually uses where the normalized word lost its accent. */
const NATURAL: Readonly<Record<string, string>> = { hackaton: "Hackatón", evaluacion: "Evaluación" };

/** ADR-0014 §5: lowercase, uppercase, accented or capitalized, and inside kebab, snake and camel identifiers. */
function variants(word: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["lowercase", `the ${word} said`],
    ["uppercase", `NOTICE: ${word.toUpperCase()}!`],
    ["accented or capitalized", `${NATURAL[word] ?? capital(withAccent(word))}: ingresar`],
    ["kebab identifier", `brk-${word}-01`],
    ["snake identifier", `${word.toUpperCase()}_TEST_PASSWORD`],
    ["camel identifier", `is${capital(word)}Claim`],
  ];
}

/** The rows of the table of ADR-0014 §2 as `{ group, terms }`. */
function adrTable(): { group: number; terms: string[] }[] {
  const markdown = readFileSync(join(REPO, ADR), "utf8");
  const section = markdown.slice(markdown.indexOf("## 2."), markdown.indexOf("## 3."));
  return [...section.matchAll(/^\|\s*(\d+)\s*\|[^|]*\|([^|]*)\|\s*$/gm)].map((row) => ({
    group: Number(row[1]),
    terms: [...(row[2] ?? "").matchAll(/`([^`]+)`/g)].map((term) => term[1] ?? ""),
  }));
}

describe("[FL-125] the list of ADR-0014 §2", () => {
  it("is exactly the table of the ADR, row by row, so removing a word fails here", () => {
    expect(NEUTRAL_GROUPS.map((entry) => ({ group: entry.group, terms: [...entry.terms] }))).toEqual(adrTable());
    expect(NEUTRAL_GROUPS.find((entry) => entry.group === 5)?.terms).toEqual([NEUTRAL_PHRASE]);
  });
});

describe("[FL-125] findNeutralHits", () => {
  it.each(NEUTRAL_WORDS)("%s: every variant gives exactly one hit on its own line", (word) => {
    for (const [kind, variant] of variants(word)) {
      expect(findNeutralHits(`Legajo listo\n${variant}\nPowered by Craftech`), `${kind}: ${variant}`).toEqual([{ line: 2, word, group: groupOf(word) }]);
    }
  });

  it.each(["Built on AWS CDS", "the aws-cds stack", "AwsCdsStack", "AWS_CDS_TEAM"])("finds the phrase in %s", (text) => {
    expect(findNeutralHits(text)).toEqual([{ line: 1, word: NEUTRAL_PHRASE, group: 5 }]);
  });

  it.each(["judgement", "prejudged", "premium", "concursal", "evaluar", "jurisdicción", "cdsx aws", "aws\ncds", "aws el cds"])("never matches %s", (text) => {
    expect(findNeutralHits(text)).toEqual([]);
  });

  it("splits digit boundaries, reports a word once per line and keeps line order", () => {
    const [first, second] = NEUTRAL_WORDS;
    expect(findNeutralHits(`${first}01 and ${first}\n\n${second}`)).toEqual([
      { line: 1, word: first, group: 1 },
      { line: 3, word: second, group: 1 },
    ]);
  });

  it("limits the search to the groups it is given", () => {
    const text = NEUTRAL_GROUPS.map((entry) => entry.terms[0]).join("\n");
    expect(findNeutralHits(text, [3]).map((hit) => hit.group)).toEqual([3]);
    expect(findNeutralHits(text).map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---- Command line over a temporary tree ---------------------------------------------------------

const ROLE_WORD = "judge";
const CONTEST_WORD = "hackathon";

/** One file per row of ADR-0014 §4. */
const ROW_SAMPLES: Readonly<Record<string, string>> = {
  "packages/web/src/**": "packages/web/src/views/landing/copy-en.ts",
  "packages/web/index.html": "packages/web/index.html",
  "packages/web/public/**": "packages/web/public/legal/terms.html",
  "packages/bff/src/copy/**": "packages/bff/src/copy/es-AR.ts",
  "packages/bff/src/public-web/**": "packages/bff/src/public-web/page-script.ts",
  "packages/bff/src/auth-triggers/messages/**": "packages/bff/src/auth-triggers/messages/es.ts",
  "packages/bff/src/leads/notice/**": "packages/bff/src/leads/notice/template.ts",
  "packages/reader-mock/src/**": "packages/reader-mock/src/catalog.ts",
  "packages/platform-mock/src/**": "packages/platform-mock/src/schema.ts",
  "packages/shared/src/consent-texts.ts": "packages/shared/src/consent-texts.ts",
  "infra/auth-email.ts": "infra/auth-email.ts",
  "scripts/channels/whatsapp-templates.ts": "scripts/channels/whatsapp-templates.ts",
  "scripts/seed/data/**": "scripts/seed/data/worlds/guest.json",
  "scripts/seed/pdfs/**": "scripts/seed/pdfs/op-4471/COMMERCIAL_INVOICE-v1.pdf",
};

/** One file per exclusion, inside a scanned row whenever the exclusion can be. */
const EXCLUSION_SAMPLES: Readonly<Record<string, string>> = {
  "**/*.test.*": "packages/web/src/views/landing/landing.test.ts",
  "**/__snapshots__/**": "packages/bff/src/copy/__snapshots__/templates.json",
  "**/testing/**": "packages/web/src/lib/auth/testing/fake-cognito.ts",
  "packages/web/e2e/**": "packages/web/e2e/landing.spec.ts",
  "README.md": "README.md",
  "docs/**": "docs/landing-spec.md",
  ".claude/**": ".claude/agents/devops.md",
  "CLAUDE.md": "CLAUDE.md",
  "CONTEXT.md": "CONTEXT.md",
  ".github/**": ".github/workflows/ci.yml",
  "scripts/lint/**": "scripts/lint/neutral-words.ts",
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Readonly<Record<string, string | Uint8Array>>): string {
  const root = mkdtempSync(join(tmpdir(), "neutral-surfaces-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function pdfWith(lines: readonly string[], title = "Commercial invoice"): Uint8Array {
  return writePdf({ info: { Title: title }, lines: lines.map((text) => ({ text })), watermark: "SYNTHETIC", footer: "Legajo listo" });
}

async function cli(argv: readonly string[], root: string): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  return { code: await run(argv, root, io), out, err };
}

describe("[FL-125] sources mode globs", () => {
  it("has one test row per glob and per exclusion of ADR-0014 §4", () => {
    expect(Object.keys(ROW_SAMPLES)).toEqual([...SOURCE_GLOBS]);
    expect(Object.keys(EXCLUSION_SAMPLES)).toEqual([...EXCLUDED_GLOBS]);
    for (const [glob, path] of Object.entries(ROW_SAMPLES)) expect(globToRegExp(glob).test(path), glob).toBe(true);
    for (const [glob, path] of Object.entries(EXCLUSION_SAMPLES)) {
      expect(globToRegExp(glob).test(path), glob).toBe(true);
      expect(isVisibleSource(path), path).toBe(false);
    }
  });

  it("reads every row and no exclusion, nothing outside the rows and no binary file", async () => {
    const line = `Texto visible: ${ROLE_WORD}`;
    const files: Record<string, string | Uint8Array> = {
      "packages/bff/src/handlers/turn.ts": line,
      "packages/web/public/brand/logo.png": line,
      "packages/web/src/node_modules/dep/index.js": line,
      "packages/web/dist/assets/index.js": line,
    };
    for (const path of [...Object.values(ROW_SAMPLES), ...Object.values(EXCLUSION_SAMPLES)]) files[path] = path.endsWith(".pdf") ? pdfWith([line]) : `export {};\n${line}\n`;
    const root = tree(files);
    const expected = Object.values(ROW_SAMPLES).sort();
    expect(sourceFiles(root)).toEqual(expected);
    const result = await cli([], root);
    expect(result.code).toBe(1);
    const hits = result.err.filter((entry) => !entry.startsWith("neutral-surfaces:"));
    expect(hits.map((entry) => entry.replace(/:\d+: /, ": "))).toEqual(expected.map((path) => `${path}: ${ROLE_WORD}`));
    expect(hits.filter((entry) => !entry.includes(".pdf:"))).toEqual(expected.filter((path) => !path.endsWith(".pdf")).map((path) => `${path}:2: ${ROLE_WORD}`));
  });

  it("reads the metadata of a seed PDF, like lint:forbidden", async () => {
    const root = tree({ [ROW_SAMPLES["scripts/seed/pdfs/**"] ?? ""]: pdfWith(["Packing list"], `Packing list ${capital(CONTEST_WORD)} 2026`) });
    const result = await cli([], root);
    expect(result.code).toBe(1);
    expect(result.err.some((entry) => entry.endsWith(`: ${CONTEST_WORD}`))).toBe(true);
  });

  it("prints the number of files and exits 0 without hits, with no secret in the environment", async () => {
    const root = tree({ "packages/web/src/app.tsx": "export const title = 'Legajo listo';\n", "scripts/seed/pdfs/op-1/A.pdf": pdfWith(["Commercial invoice"]) });
    expect(await cli([], root)).toEqual({ code: 0, out: ["neutral-surfaces: 2 visible source file(s) checked, no listed word."], err: [] });
  });
});

describe("[FL-125] --dist", () => {
  it("fails closed with exit 2 when the build is missing or has no text file", async () => {
    expect((await cli(["--dist"], tree({ "packages/web/src/app.tsx": "x" }))).code).toBe(2);
    const empty = tree({});
    mkdirSync(join(empty, "packages/web/dist"), { recursive: true });
    expect((await cli(["--dist"], empty)).code).toBe(2);
    expect((await cli(["--dist"], tree({ "packages/web/dist/brand/logo.png": "x" }))).code).toBe(2);
  });

  it("exits 1 on minified JavaScript that carries a listed word", async () => {
    const root = tree({ "packages/web/dist/assets/index-3f9a.js": 'const e="JUDGE";function t(n){return n===e}export{t as a};', "packages/web/dist/index.html": "<title>Legajo listo</title>" });
    const result = await cli(["--dist"], root);
    expect(result.code).toBe(1);
    expect(result.err[0]).toBe(`packages/web/dist/assets/index-3f9a.js:1: ${ROLE_WORD}`);
  });

  it("exits 0 on a clean build and never reads the sources", async () => {
    const root = tree({ "packages/web/dist/index.html": "<title>Legajo listo</title>", "packages/web/src/app.tsx": ROLE_WORD });
    expect(await cli(["--dist"], root)).toEqual({ code: 0, out: ["neutral-surfaces: 1 file(s) of packages/web/dist checked, no listed word."], err: [] });
  });
});

describe("[FL-125] --all-tree", () => {
  function gitTree(): string {
    const root = tree({
      "packages/bff/src/auth/principal.ts": "export const isJudgeClaim = (claims: object) => claims;\n",
      "docs/notes.md": `Notas internas del ${CONTEST_WORD}.\n`,
      ".github/workflows/x.yml": `name: ${ROLE_WORD} smoke\n`,
      "docs/adr/0014-superficies.md": `${ROLE_WORD}\n`,
      "scripts/lint/neutral-extra.ts": `${ROLE_WORD}\n`,
      "assets/blob.bin": new Uint8Array([0, 106, 117, 100, 103, 101]),
    });
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  it("with --group 3 finds an identifier of the role in any versioned file but not a word of group 1", async () => {
    const result = await cli(["--all-tree", "--group", "3"], gitTree());
    expect(result.code).toBe(1);
    expect(result.err.slice(0, -1)).toEqual([`.github/workflows/x.yml:1: ${ROLE_WORD}`, `packages/bff/src/auth/principal.ts:1: ${ROLE_WORD}`]);
  });

  it("without --group reads every group, and never the rename map nor the list", async () => {
    const result = await cli(["--all-tree"], gitTree());
    expect(result.err.slice(0, -1)).toEqual([
      `.github/workflows/x.yml:1: ${ROLE_WORD}`,
      `docs/notes.md:1: ${CONTEST_WORD}`,
      `packages/bff/src/auth/principal.ts:1: ${ROLE_WORD}`,
    ]);
    expect(ALL_TREE_EXCLUDED_GLOBS).toEqual(["docs/adr/0014-*", "scripts/lint/neutral-*"]);
  });

  it.each([[["--group", "0"]], [["--group", "6"]], [["--group", "frase"]], [["--group", "03"]], [["--group"]]])("exits 2 on --all-tree %j", async (args) => {
    expect((await cli(["--all-tree", ...args], gitTree())).code).toBe(2);
  });

  it.each([[["--group", "3"]], [["--dist", "--all-tree"]], [["--all"]]])("exits 2 on %j", async (argv) => {
    expect(parseArgs(argv)).toHaveProperty("error");
    expect((await cli(argv, tree({}))).code).toBe(2);
  });
});
