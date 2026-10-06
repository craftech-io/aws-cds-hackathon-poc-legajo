// Language of the authenticated console. One module-level value, `activeLang()`, read by every text
// the console renders (copy/localized.ts resolves its accessors against it) and by the date and number
// formats (lib/format.ts); the provider of context/ConsoleLangContext.tsx sets it before it renders the
// console and remounts the tree when the person changes it, so no component needs to subscribe.
//
// It starts as Spanish (the console's original language, and what a Node process such as a test or a
// script reads) and goes back to it outside the console. Which language the console opens in is
// decided by lib/preferred-lang.ts (the visitor's remembered choice, else the browser's) and, once it
// loads, by the account's own preference kept on the server.
//
// No browser API here: scripts and tests import this module through the formats and the copy.
import type { Language } from "@legajo/shared";

let active: Language = "es";

export function activeLang(): Language {
  return active;
}

export function setActiveLang(lang: Language): void {
  active = lang;
}

/** Reads texts in `lang` without leaving it behind: a screen that is not the console's (its loading message). */
export function inLang<T>(lang: Language, read: () => T): T {
  const previous = active;
  active = lang;
  try {
    return read();
  } finally {
    active = previous;
  }
}

/** Each language in its own words: the selector never translates them. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { es: "Español", en: "English" };

/** BCP 47 tag of the language, for `lang` attributes. */
export const LANGUAGE_TAGS: Readonly<Record<Language, string>> = { es: "es-AR", en: "en" };
