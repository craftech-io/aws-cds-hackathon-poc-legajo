// Language of the public pages (docs/landing-spec.md D-02): `?lang=es` or `?lang=en` wins; else the
// visitor's last choice (localStorage, which may throw); else the browser's language (`en*` → en,
// anything else → es). The landing and the access screens share the same remembered choice.
import { Language } from "@legajo/shared";

export const LANG_STORAGE_KEY = "legajo.lang";
export const LANG_PARAM = "lang";

function localStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredLang(): Language | undefined {
  try {
    const parsed = Language.safeParse(localStore()?.getItem(LANG_STORAGE_KEY));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function storeLang(lang: Language): void {
  try {
    localStore()?.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // Not remembered: the next visit falls back to the browser's language.
  }
}

/** D-02 in order: the query, the remembered choice, the browser. */
export function resolveLang(search: URLSearchParams, stored: Language | undefined, browserLanguage: string | undefined): Language {
  const asked = Language.safeParse(search.get(LANG_PARAM));
  if (asked.success) return asked.data;
  if (stored) return stored;
  return browserLanguage?.toLowerCase().startsWith("en") ? "en" : "es";
}

/** The page's language right now, from the address, storage and the browser. */
export function currentLang(search: URLSearchParams): Language {
  const browser = typeof navigator === "undefined" ? undefined : navigator.language;
  return resolveLang(search, readStoredLang(), browser);
}

/** `path` with `?lang=en` kept (Spanish needs no parameter), plus any other query of `extra`. */
export function hrefWithLang(path: string, lang: Language, extra?: URLSearchParams): string {
  const query = new URLSearchParams(extra);
  query.delete(LANG_PARAM);
  if (lang === "en") query.set(LANG_PARAM, "en");
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
