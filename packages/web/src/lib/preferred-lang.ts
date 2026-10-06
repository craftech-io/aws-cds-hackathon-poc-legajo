// The one place that decides which language a first-time visitor gets and where an explicit choice is
// kept (docs/landing-spec.md D-02). The landing, the sign-in screens and the console read the same two
// things from here, so a visitor never changes language between pages.
import { Language } from "@legajo/shared";

/** `localStorage` key of the visitor's explicit choice; it always beats the browser's language. */
export const LANG_STORAGE_KEY = "legajo.lang";

/** The browser's preferred languages, most preferred first (an empty list outside a browser). */
function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * Spanish when the browser lists any Spanish variant (`es`, `es-AR`, `es-419`…), English otherwise.
 * `languages` is only for tests; the default is `navigator.languages`.
 */
export function browserLang(languages: readonly string[] = browserLanguages()): Language {
  return languages.some((tag) => /^es(-|_|$)/i.test(tag.trim())) ? "es" : "en";
}

/** The visitor's explicit choice kept in `localStorage`, if any and if storage is reachable. */
function storedLang(): Language | undefined {
  try {
    const parsed = Language.safeParse(globalThis.localStorage?.getItem(LANG_STORAGE_KEY));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The console's language before the server answers: the choice made on the landing or the access
 * screens, else the browser's. The account's own preference (lib/console-lang.ts, ADR-0020) replaces it.
 */
export function initialConsoleLang(): Language {
  return storedLang() ?? browserLang();
}
