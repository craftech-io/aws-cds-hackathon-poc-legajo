// The language-keyed copy of the console (copy/localized.ts, ADR-0020): how the accessors behave, and
// that every dictionary of the console has the same keys, kinds of value and argument counts in both
// languages (the compiler checks the typed part; open-key records and arities are checked here).
import { afterEach, describe, expect, it } from "vitest";
import { setActiveLang } from "../lib/console-lang";
import { localized, registeredDictionaries } from "./localized";
// Importing a copy module registers its dictionary: every copy module of the console is listed here.
import "./console";
import "./console-data";
import "./rules";
import "../views/audit/copy";
import "../views/clock/copy";
import "../views/dossier/copy";
import "../views/dossier/labels";
import "../views/escalations/copy";
import "../views/mailbox/copy";
import "../views/metrics/copy";
import "../views/operations/copy";
import "../views/registry/copy";
import "../views/simulator/copy";

afterEach(() => setActiveLang("es"));

describe("[FL-133] localized copy", () => {
  const sample = localized({
    es: { title: "Hola", list: ["uno", "dos"], nested: { label: "Sí" }, count: (n: number) => (n === 1 ? "1 cosa" : `${n} cosas`), by: { A: "a", B: "b" } as Readonly<Record<string, string>> },
    en: { title: "Hello", list: ["one", "two"], nested: { label: "Yes" }, count: (n: number) => (n === 1 ? "1 thing" : `${n} things`), by: { A: "a", B: "b" } },
  });

  it("answers each text in the language the console is in, read again on every access", () => {
    expect(sample.title).toBe("Hola");
    expect(sample.count(2)).toBe("2 cosas");
    setActiveLang("en");
    expect(sample.title).toBe("Hello");
    expect(sample.count(2)).toBe("2 things");
    expect(sample.nested.label).toBe("Yes");
    expect(sample.list.map((item) => item)).toEqual(["one", "two"]);
    expect(sample.by["A"]).toBe("a");
  });

  it("keeps the identity of objects, arrays and functions, so a constant captured at import time still follows", () => {
    const { nested, list, count } = sample;
    setActiveLang("en");
    expect(nested.label).toBe("Yes");
    expect(list[0]).toBe("one");
    expect(count(1)).toBe("1 thing");
    expect(sample.nested).toBe(nested);
    expect(sample.list).toBe(list);
    expect(sample.count).toBe(count);
  });

  it("behaves as plain data: keys, entries, spread and JSON read the current language", () => {
    expect(Object.keys(sample)).toEqual(["title", "list", "nested", "count", "by"]);
    expect(Array.isArray(sample.list)).toBe(true);
    expect(sample.list).toHaveLength(2);
    setActiveLang("en");
    expect({ ...sample.nested }).toEqual({ label: "Yes" });
    expect(Object.entries(sample.by)).toEqual([["A", "a"], ["B", "b"]]);
    expect(JSON.stringify([...sample.list])).toBe('["one","two"]');
  });
});

/** The skeleton of a value: its kind, a function's argument count, and the keys under it. */
function skeleton(value: unknown, path = "$"): string[] {
  if (typeof value === "function") return [`${path}: function/${value.length}`];
  if (Array.isArray(value)) return [`${path}: array/${value.length}`, ...value.flatMap((item, index) => skeleton(item, `${path}[${index}]`))];
  if (typeof value === "object" && value !== null) return [`${path}: object`, ...Object.keys(value).sort().flatMap((key) => skeleton(Reflect.get(value, key), `${path}.${key}`))];
  return [`${path}: ${typeof value}`];
}

describe("[FL-133] the console speaks both languages with one shape", () => {
  const dictionaries = registeredDictionaries();

  it("has every copy module registered", () => {
    expect(dictionaries.length).toBeGreaterThanOrEqual(12);
  });

  it("gives English the keys, kinds of value and argument counts of the Spanish, and no empty text", () => {
    for (const [index, dictionary] of dictionaries.entries()) {
      expect(skeleton(dictionary.en), `dictionary #${index}`).toEqual(skeleton(dictionary.es));
    }
  });

  it("writes no empty string in either language", () => {
    const empty = (value: unknown, path: string): string[] => {
      if (typeof value === "string") return value.trim() === "" ? [path] : [];
      if (typeof value !== "object" || value === null) return [];
      return Object.entries(value).flatMap(([key, item]) => empty(item, `${path}.${key}`));
    };
    for (const [index, dictionary] of dictionaries.entries()) {
      // A few Spanish texts are empty on purpose (a separator): the English one must be too.
      expect(empty(dictionary.en, `#${index}`).sort(), `dictionary #${index}`).toEqual(empty(dictionary.es, `#${index}`).sort());
    }
  });
});
