// The language a visitor who has not signed in yet should read: the one it picked on the landing or the
// access screens (views/auth/lang.ts, `LANG_STORAGE_KEY`), else the browser's (`browserLang`). Once the
// console loads, the account's own preference (lib/console-lang.ts, ADR-0020) replaces it.
import type { Language } from "@legajo/shared";
import { readStoredLang } from "../views/auth/lang";

const SPANISH = /^es(?:-|$)/i;

/** The browser's preferred languages, most preferred first; none outside a browser. */
function navigatorLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

/** Spanish when any preferred language is Spanish (`es`, `es-AR`, `es-419`…), English otherwise. */
export function browserLang(languages: readonly string[] = navigatorLanguages()): Language {
  return languages.some((tag) => SPANISH.test(tag)) ? "es" : "en";
}

/** Before the server answers: the visitor's remembered choice, else the browser's language. */
export function initialConsoleLang(): Language {
  return readStoredLang() ?? browserLang();
}
