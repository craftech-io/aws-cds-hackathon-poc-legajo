// Language of the landing: Spanish by default, English with `?lang=en` so a shared link opens in the
// same language, and a switch on the page that keeps the address in step. The document's `lang`
// follows, so a screen reader reads each version in its language. React context, no state library.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "../../lib/router";
import { LANDING_COPY, type LandingCopy, type LandingLang } from "./copy";

interface LandingLangValue {
  readonly lang: LandingLang;
  readonly copy: LandingCopy;
  setLang(lang: LandingLang): void;
}

const LandingLangContext = createContext<LandingLangValue | undefined>(undefined);

export function langFromSearch(search: URLSearchParams): LandingLang {
  return search.get("lang") === "en" ? "en" : "es";
}

/** The landing's address in `lang`: `?lang=en` only for English, the section anchor kept. */
export function landingHref(path: string, lang: LandingLang, hash: string): string {
  return `${path}${lang === "en" ? "?lang=en" : ""}${hash}`;
}

export function LandingLangProvider({ initial, children }: { readonly initial: LandingLang; readonly children: ReactNode }) {
  const { path, navigate } = useRouter();
  const [lang, setCurrent] = useState<LandingLang>(initial);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.lang;
    root.lang = LANDING_COPY[lang].lang.code;
    return () => {
      root.lang = previous;
    };
  }, [lang]);

  const setLang = useCallback(
    (next: LandingLang) => {
      setCurrent(next);
      navigate(landingHref(path, next, window.location.hash), { replace: true });
    },
    [navigate, path],
  );

  const value = useMemo<LandingLangValue>(() => ({ lang, copy: LANDING_COPY[lang], setLang }), [lang, setLang]);
  return <LandingLangContext.Provider value={value}>{children}</LandingLangContext.Provider>;
}

/** Spanish outside a provider, so a reused figure never renders without text. */
export function useLandingCopy(): LandingCopy {
  return useContext(LandingLangContext)?.copy ?? LANDING_COPY.es;
}

export function useLandingLang(): LandingLangValue | undefined {
  return useContext(LandingLangContext);
}
