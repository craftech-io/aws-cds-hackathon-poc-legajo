import { QuotaKind } from "@legajo/shared/guest-limits";
import { describe, expect, it } from "vitest";
import { findNeutralHits } from "../../../../../scripts/lint/neutral-words";
import { AUTH_COPY } from "./copy";

type Leaf = { readonly path: string; readonly value: unknown };

function leaves(value: unknown, path = ""): Leaf[] {
  if (typeof value === "string" || typeof value === "function") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, item]) => leaves(item, path ? `${path}.${key}` : key));
  return [{ path, value }];
}

const SENTINEL_NUMBER = 7777;

/** Every text of a deck as it reaches a screen: functions called with a sentinel for every argument. */
function texts(deck: unknown): Array<{ readonly path: string; readonly text: string }> {
  return leaves(deck).map(({ path, value }) => {
    if (typeof value === "function") {
      const args = Array.from({ length: value.length }, () => SENTINEL_NUMBER);
      return { path, text: String((value as (...args: unknown[]) => unknown)(...args)) };
    }
    return { path, text: String(value) };
  });
}

// Facts of the synthetic world and of the brand line, never a limit of the demo.
const ALLOWED_DIGITS = ["4471", "14/10", "10:30", "100 %", "día 0", "day 0"];

describe("[FL-120] access texts in Spanish and English", () => {
  it("[FL-120] has the same keys, list lengths and argument counts in both languages", () => {
    const es = leaves(AUTH_COPY.es);
    const en = leaves(AUTH_COPY.en);
    expect(en.map((leaf) => leaf.path)).toEqual(es.map((leaf) => leaf.path));
    for (const [index, leaf] of es.entries()) {
      const other = en[index]?.value;
      expect(typeof other, leaf.path).toBe(typeof leaf.value);
      if (typeof leaf.value === "function" && typeof other === "function") expect(other.length, leaf.path).toBe(leaf.value.length);
    }
  });

  it("[FL-120] declares the page language of each deck", () => {
    expect(AUTH_COPY.es.lang.code).toBe("es-AR");
    expect(AUTH_COPY.en.lang.code).toBe("en");
  });

  it("[FL-111] labels every kind of usage quota in both languages", () => {
    for (const kind of QuotaKind.options) {
      expect(AUTH_COPY.es.quota.kinds[kind]).toMatch(/\S/);
      expect(AUTH_COPY.en.quota.kinds[kind]).toMatch(/\S/);
    }
  });

  it("writes no limit by hand: every number on screen arrives as an argument (D-12)", () => {
    for (const deck of [AUTH_COPY.es, AUTH_COPY.en]) {
      for (const { path, text } of texts(deck)) {
        let rest = text.replaceAll(String(SENTINEL_NUMBER), "");
        for (const allowed of ALLOWED_DIGITS) rest = rest.replaceAll(allowed, "");
        expect(rest, path).not.toMatch(/\d/);
      }
    }
  });

  it("[FL-125] uses none of the words of the neutral-surfaces guard", () => {
    for (const deck of [AUTH_COPY.es, AUTH_COPY.en]) {
      for (const { path, text } of texts(deck)) expect(findNeutralHits(text), path).toEqual([]);
    }
  });

  it("has one sign-up only: no waitlist, no access request, no puzzle", () => {
    const all = [AUTH_COPY.es, AUTH_COPY.en].flatMap((deck) => texts(deck).map(({ text }) => text.toLowerCase()));
    for (const banned of ["lista de espera", "waitlist", "pedir acceso", "request access", "captcha", "rompecabezas", "puzzle", "sos una persona"]) {
      expect(all.some((text) => text.includes(banned)), banned).toBe(false);
    }
  });
});
