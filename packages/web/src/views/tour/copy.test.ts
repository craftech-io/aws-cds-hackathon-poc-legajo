// FL-131 · the texts of the guided tour as a guest who signed up alone reads them (docs/landing-spec.md
// D-09): the panel's texts and every step, in Spanish and English, with the same keys and placeholders,
// none of the words of the neutral-surfaces guard and nothing about accounts handed out by someone else.
import { describe, expect, it } from "vitest";
import { findNeutralHits } from "../../../../../scripts/lint/neutral-words";
import { TOUR_TEXTS } from "./copy";
import { type Bilingual, TOUR_STEPS, type TourLang, lookText, placeholdersOf } from "./steps";

type Leaf = { readonly path: string; readonly value: unknown };

function leaves(value: unknown, path = ""): Leaf[] {
  if (typeof value === "string" || typeof value === "function") return [{ path, value }];
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, item]) => leaves(item, path ? `${path}.${key}` : key));
  return [{ path, value }];
}

/** A panel text as it reaches the screen: functions called with a sample for every argument. */
function rendered(leaf: Leaf): string {
  if (typeof leaf.value !== "function") return String(leaf.value);
  const args = Array.from({ length: leaf.value.length }, (_, index) => `arg${index}`);
  return String((leaf.value as (...values: unknown[]) => unknown)(...args));
}

/** Every bilingual text of the steps, by where it is. */
function stepTexts(): Array<{ readonly path: string; readonly text: Bilingual }> {
  return TOUR_STEPS.flatMap((step) => [
    { path: `${step.id}.title`, text: step.title },
    { path: `${step.id}.look`, text: step.look },
    { path: `${step.id}.wait`, text: step.wait },
    ...step.moves.map((move, index) => ({ path: `${step.id}.moves[${index}]`, text: move.label })),
  ]);
}

/** Everything the panel can show in `lang`, "Qué mirar" with its hours filled in. */
function allTexts(lang: TourLang): Array<{ readonly path: string; readonly text: string }> {
  return [
    ...leaves(TOUR_TEXTS[lang]).map((leaf) => ({ path: leaf.path, text: rendered(leaf) })),
    ...stepTexts().map(({ path, text }) => ({ path, text: text[lang] })),
    ...TOUR_STEPS.map((step) => ({ path: `${step.id}.look (filled)`, text: lookText(step, lang) })),
  ];
}

/** What a guest who signed up alone never reads: accounts handed out, their ids or their secrets (D-09). */
const NOT_FOR_A_SELF_SIGNED_GUEST = ["asignad", "assigned", "reservad", "reserved", "credencial", "credential", "guest-", "usr-", "instrucciones de prueba", "test instructions"];

describe("[FL-131] the guided tour's texts in Spanish and English", () => {
  it("[FL-131] the panel has the same keys and argument counts in both languages", () => {
    const es = leaves(TOUR_TEXTS.es);
    const en = leaves(TOUR_TEXTS.en);
    expect(en.map((leaf) => leaf.path)).toEqual(es.map((leaf) => leaf.path));
    for (const [index, leaf] of es.entries()) {
      const other = en[index]?.value;
      expect(typeof other, leaf.path).toBe(typeof leaf.value);
      if (typeof leaf.value === "function" && typeof other === "function") expect(other.length, leaf.path).toBe(leaf.value.length);
      expect(rendered(leaf).trim(), leaf.path).not.toBe("");
    }
  });

  it("[FL-131] every step is written in both languages, with the same hours to fill in", () => {
    for (const { path, text } of stepTexts()) {
      expect(text.es.trim(), path).not.toBe("");
      expect(text.en.trim(), path).not.toBe("");
      expect(placeholdersOf(text.en).sort(), path).toEqual(placeholdersOf(text.es).sort());
    }
    for (const step of TOUR_STEPS) {
      for (const name of placeholdersOf(step.look.es)) expect(step.times[name], `${step.id}.${name}`).toBeDefined();
      for (const lang of ["es", "en"] as const) expect(lookText(step, lang), `${step.id}.${lang}`).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });

  it("[FL-131] uses none of the words of the neutral-surfaces guard", () => {
    for (const lang of ["es", "en"] as const) {
      for (const { path, text } of allTexts(lang)) expect(findNeutralHits(text), `${lang}:${path}`).toEqual([]);
    }
  });

  it("[FL-131] speaks to a guest who signed up alone: no accounts handed out, no account ids, no secrets", () => {
    for (const lang of ["es", "en"] as const) {
      for (const { path, text } of allTexts(lang)) {
        const lower = text.toLowerCase();
        for (const banned of NOT_FOR_A_SELF_SIGNED_GUEST) expect(lower.includes(banned), `${lang}:${path} says "${banned}"`).toBe(false);
      }
    }
  });

  it("[FL-131] the first step tells the guest the world is its own and created at the first sign-in", () => {
    const [first] = TOUR_STEPS;
    expect(first?.look.es).toContain("Tu mundo propio");
    expect(first?.look.en).toContain("Your own world");
    expect(first?.wait.es).toContain("se crea el mundo");
    expect(first?.wait.en).toContain("your world is created");
  });
});
