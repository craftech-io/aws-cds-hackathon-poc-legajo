// Language and page metadata of an access screen: the D-02 language (lang.ts) with its switch, the
// `<html lang>` and the document title of the screen, and `noindex` while it is open (robots.txt
// already disallows these paths; ADR-0016 §1). React context, no state library. Outside a provider
// (the console's security prompts) the texts follow the console's language, like the rest of the console.
import type { Language } from "@legajo/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { activeLang } from "../../lib/console-lang";
import { useRouter } from "../../lib/router";
import { AUTH_COPY, type AuthCopy } from "./copy";
import { LANG_PARAM, currentLang, hrefWithLang, storeLang } from "./lang";

/** `public`: an access screen; `console`: a prompt inside the console, which keeps the console's look. */
export type AuthSurface = "public" | "console";

interface AuthLangValue {
  readonly lang: Language;
  readonly copy: AuthCopy;
  readonly surface: AuthSurface;
  setLang(lang: Language): void;
}

const AuthLangContext = createContext<AuthLangValue | undefined>(undefined);

/** `<meta name="robots" content="noindex">` while the page is open (access screens and the console). */
export function useNoIndex(): void {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.append(meta);
    return () => meta.remove();
  }, []);
}

export type TitleKey = keyof AuthCopy["titles"];

export function AuthLangProvider({ title, children }: { readonly title: TitleKey; readonly children: ReactNode }) {
  const { path, search, navigate } = useRouter();
  const [lang, setCurrent] = useState<Language>(() => currentLang(search));
  const copy = AUTH_COPY[lang];
  useNoIndex();

  // A link that names a language (`?lang=en`) wins over the remembered one, also after mounting, and
  // becomes the visitor's choice: the next screens (`/welcome` after the sign-in) open in it too.
  const asked = search.get(LANG_PARAM);
  useEffect(() => {
    if (asked !== "es" && asked !== "en") return;
    setCurrent(asked);
    storeLang(asked);
  }, [asked]);

  useEffect(() => {
    const root = document.documentElement;
    const previous = { lang: root.lang, title: document.title };
    root.lang = copy.lang.code;
    document.title = copy.titles[title];
    return () => {
      root.lang = previous.lang;
      document.title = previous.title;
    };
  }, [copy, title]);

  const setLang = useCallback(
    (next: Language) => {
      storeLang(next);
      setCurrent(next);
      navigate(hrefWithLang(path, next, search), { replace: true });
    },
    [navigate, path, search],
  );

  const value = useMemo<AuthLangValue>(() => ({ lang, copy, surface: "public", setLang }), [lang, copy, setLang]);
  return <AuthLangContext.Provider value={value}>{children}</AuthLangContext.Provider>;
}

/** Inside the console the prompts follow the console's language, which the account menu changes (ADR-0020). */
function consoleValue(): AuthLangValue {
  const lang = activeLang();
  return { lang, copy: AUTH_COPY[lang], surface: "console", setLang: () => undefined };
}

export function useAuthLang(): AuthLangValue {
  return useContext(AuthLangContext) ?? consoleValue();
}

export function useAuthCopy(): AuthCopy {
  return useAuthLang().copy;
}
