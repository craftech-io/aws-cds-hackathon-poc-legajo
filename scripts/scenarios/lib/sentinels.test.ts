// The Memory sentinels stay apart from every other text the agent could see (docs/tool-catalog.md
// `memory.inspect`): a word of A or B in the copy, the seed, the scripted plans or another step of
// SC-09/SC-20 would make a record match for the wrong reason, and a negative on B would pass or fail by
// accident.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { foldText, matchesKeywords, wordsOf } from "@legajo/bff/qa-driver/keywords";
import { SC09_TEXTS } from "../sc-09-questions";
import { FIRST_PERSON_WORDS, SENTINELS, THIRD_PARTY_WORDS, sentinelMessage } from "./sentinels";

const ROOT = join(import.meta.dirname, "../../..");
const TONE = [...SENTINELS.A.keywords, ...SENTINELS.B.keywords];

function filesUnder(dir: string, accept: (path: string) => boolean): string[] {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  const walk = (path: string): void => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) if (entry !== "node_modules") walk(join(path, entry));
    } else if (accept(path)) out.push(path);
  };
  walk(absolute);
  return out;
}

/** Whole words of the tone sentinels found in a text, folded. */
const toneWordsIn = (text: string): string[] => wordsOf(text).filter((word) => TONE.some((keyword) => foldText(keyword) === word));

/** String literals of a TypeScript source (quotes and template literals, without their `${…}`). */
function literalsOf(source: string): string[] {
  return [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((match) => (match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, " "));
}

const root4 = (word: string) => foldText(word).slice(0, 4);

describe("Memory sentinels (SC-09/11, SC-20/5)", () => {
  it("each phrase matches its own keywords, and only its own", () => {
    expect(matchesKeywords(SENTINELS.A.phrase, SENTINELS.A.keywords)).toBe(true);
    expect(matchesKeywords(SENTINELS.B.phrase, SENTINELS.B.keywords)).toBe(true);
    expect(matchesKeywords(SENTINELS.F.phrase, SENTINELS.F.keywords)).toBe(true);
    expect(matchesKeywords(SENTINELS.A.phrase, SENTINELS.B.keywords)).toBe(false);
    expect(matchesKeywords(SENTINELS.B.phrase, SENTINELS.A.keywords)).toBe(false);
    expect(toneWordsIn(SENTINELS.F.phrase)).toEqual([]);
    const allowed: readonly string[] = SENTINELS.A.keywords;
    expect(toneWordsIn(sentinelMessage(SENTINELS.A, SC09_TEXTS.sensitive)).every((word) => allowed.includes(word))).toBe(true);
  });

  it("A and B share no word and no root", () => {
    const a = new Set(SENTINELS.A.keywords.map(root4));
    const b = new Set(SENTINELS.B.keywords.map(root4));
    expect(SENTINELS.A.keywords.filter((word) => (SENTINELS.B.keywords as readonly string[]).includes(word))).toEqual([]);
    expect([...a].filter((root) => b.has(root))).toEqual([]);
  });

  it("the fact is the importer's own, in the first person, and names no third party", () => {
    const words = wordsOf(SENTINELS.F.phrase);
    expect(FIRST_PERSON_WORDS.some((word) => words.includes(foldText(word)))).toBe(true);
    expect(THIRD_PARTY_WORDS.filter((word) => words.includes(foldText(word)))).toEqual([]);
    const seedNames = filesUnder("scripts/seed/data", (path) => path.endsWith(".json"))
      .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""))
      .filter((name) => name.length > 3);
    expect(seedNames.filter((name) => foldText(SENTINELS.F.phrase).includes(foldText(name)))).toEqual([]);
  });

  it("no word of A or B appears in the copy the agent and the parties see", () => {
    const copy = filesUnder("packages/bff/src/copy", (path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
    expect(copy.length).toBeGreaterThan(0);
    for (const path of copy) expect(toneWordsIn(readFileSync(path, "utf8")), path).toEqual([]);
  });

  it("no word of A or B appears in the seed, its checklist or the world templates", () => {
    for (const path of filesUnder("scripts/seed/data", (file) => /\.(json|jsonl|csv|txt)$/.test(file))) expect(toneWordsIn(readFileSync(path, "utf8")), path).toEqual([]);
  });

  it("no word of A or B appears in the plans of the scripted Harness", () => {
    for (const path of filesUnder("tests/flows", (file) => file.endsWith(".ts"))) expect(toneWordsIn(readFileSync(path, "utf8")), path).toEqual([]);
  });

  it("no other step of SC-09 or SC-20 writes a word of A or B", () => {
    for (const text of Object.values(SC09_TEXTS).flat()) expect(toneWordsIn(text), text).toEqual([]);
    const scenarios = filesUnder("scripts/scenarios", (path) => /\/sc-(09|20)-[^/]+\.ts$/.test(path));
    expect(scenarios).toHaveLength(2);
    for (const path of scenarios) for (const literal of literalsOf(readFileSync(path, "utf8"))) expect(toneWordsIn(literal), `${path}: "${literal}"`).toEqual([]);
  });
});
