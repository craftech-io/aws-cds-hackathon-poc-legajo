// Language-keyed copy of the console. A module writes its Spanish texts first (`const es = {…} as const`),
// derives their shape (`type X = Widen<typeof es>`), writes the English ones against it
// (`const en = {…} satisfies X`, so a missing, extra or differently typed key does not compile) and
// exports `localized({ es, en })`: an object of the same shape whose texts are live accessors over
// `activeLang()` (lib/console-lang.ts). A view keeps reading `copy.section.title` as before, and the
// text it gets is the one of the language the console is in when it renders; the console tree is
// remounted when the language changes (context/ConsoleLangContext.tsx), so every text is read again.
//
//   - a string, number or boolean leaf is a getter: reading it later (a constant captured at import
//     time, `const group = copy.nav.groups`) still follows the language, while copying the string itself
//     (`const label = copy.app.signOut`) freezes it for that render, as any value does;
//   - a function is a stable wrapper that calls the current language's function;
//   - arrays and objects keep one identity; their entries are the accessors above.
//
// Dictionaries with open keys (`Record<string, string>`) are the one thing the compiler cannot compare:
// `registeredDictionaries()` hands them to copy/localized.test.ts, which checks both languages hold
// exactly the same keys, argument counts and kinds of value.
import type { Language } from "@legajo/shared";
import { activeLang } from "../lib/console-lang";

/** The type of a dictionary of texts: every string widened (so the English may differ), functions kept. */
export type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends (...args: infer A) => infer R
        ? (...args: A) => Widen<R>
        : T extends object
          ? { readonly [K in keyof T]: Widen<T[K]> }
          : T;

export interface Dictionary<T> {
  readonly es: T;
  readonly en: Widen<T>;
}

type Path = readonly (string | number)[];

const registry: Dictionary<object>[] = [];

/** Every dictionary built so far, for the shape check of the tests. */
export function registeredDictionaries(): readonly Dictionary<object>[] {
  return registry;
}

function textsOf(dictionary: Readonly<Record<Language, unknown>>, language: Language, path: Path): unknown {
  let node: unknown = dictionary[language];
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = Reflect.get(node, key);
  }
  return node;
}

function isLeaf(shape: unknown): boolean {
  return typeof shape !== "object" || shape === null;
}

function define(target: object, key: string | number, dictionary: Readonly<Record<Language, unknown>>, path: Path, shape: unknown): void {
  const child: Path = [...path, key];
  if (isLeaf(shape) && typeof shape !== "function") {
    Object.defineProperty(target, key, { enumerable: true, get: () => textsOf(dictionary, activeLang(), child) });
    return;
  }
  Object.defineProperty(target, key, { enumerable: true, value: build(dictionary, child, shape) });
}

function build(dictionary: Readonly<Record<Language, unknown>>, path: Path, shape: unknown): unknown {
  if (typeof shape === "function") {
    return (...args: unknown[]): unknown => {
      const current = textsOf(dictionary, activeLang(), path);
      if (typeof current !== "function") throw new TypeError(`copy ${path.join(".")} is not a function in ${activeLang()}`);
      return Reflect.apply(current, undefined, args);
    };
  }
  if (Array.isArray(shape)) {
    const entries: unknown[] = [];
    shape.forEach((item, index) => define(entries, index, dictionary, path, item));
    return entries;
  }
  const entries: Record<string, unknown> = {};
  if (typeof shape === "object" && shape !== null) {
    for (const key of Object.keys(shape)) define(entries, key, dictionary, path, Reflect.get(shape, key));
  }
  return entries;
}

/** The texts of `dictionary` in the console's current language, with the Spanish shape. */
export function localized<T extends object>(dictionary: Dictionary<T>): Widen<T> {
  registry.push(dictionary);
  // The result has the shape of `dictionary.es`, which `Widen<T>` describes.
  return build(dictionary, [], dictionary.es) as Widen<T>;
}
