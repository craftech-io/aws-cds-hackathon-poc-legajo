// Language of the landing (docs/landing-spec.md D-02), resolved and remembered by the same helpers as
// the access screens (views/auth/lang.ts: the address, then the last choice, then the browser). The
// document's `lang` and title follow, so a screen reader reads each version in its language and the
// change is announced by the new title; the switch keeps the address in step (`?lang=en`, the other
// parameters and the anchor kept). React context, no state library.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "../../lib/router";
import { currentLang, hrefWithLang, storeLang } from "../auth/lang";
import { LANDING_COPY, type LandingCopy, type LandingLang } from "./copy";

/** The landing's address in `lang`, every other parameter and the anchor kept. */
export function landingHref(path: string, search: URLSearchParams, lang: LandingLang, hash: string): string {
  return `${hrefWithLang(path, lang, search)}${hash}`;
}

interface LandingLangValue {
  readonly lang: LandingLang;
  readonly copy: LandingCopy;
  setLang(lang: LandingLang): void;
}

const LandingLangContext = createContext<LandingLangValue | undefined>(undefined);

export function LandingLangProvider({ children }: { readonly children: ReactNode }) {
  const { path, search, navigate } = useRouter();
  const [lang, setCurrent] = useState<LandingLang>(() => currentLang(search));

  useEffect(() => {
    const root = document.documentElement;
    const previous = { lang: root.lang, title: document.title };
    root.lang = LANDING_COPY[lang].meta.code;
    document.title = LANDING_COPY[lang].meta.title;
    return () => {
      root.lang = previous.lang;
      document.title = previous.title;
    };
  }, [lang]);

  const setLang = useCallback(
    (next: LandingLang) => {
      setCurrent(next);
      storeLang(next);
      navigate(landingHref(path, new URLSearchParams(window.location.search), next, window.location.hash), { replace: true });
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

export type LandingRuleId = keyof LandingCopy["guarantees"]["rules"];

/** What a rule chip says on the English page; on the Spanish page the console's own label stays (undefined). */
export function useRuleLabel(rule: LandingRuleId): string | undefined {
  const copy = useLandingCopy();
  return copy.meta.code === "en" ? copy.guarantees.rules[rule] : undefined;
}

export function LangSwitch({ className = "" }: { readonly className?: string }) {
  const value = useLandingLang();
  if (!value) return null;
  const next: LandingLang = value.lang === "es" ? "en" : "es";
  return (
    <button
      type="button"
      lang={LANDING_COPY[next].meta.code}
      aria-label={value.copy.lang.switchLabel}
      onClick={() => value.setLang(next)}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill border border-harbor-700 px-3 text-sm font-semibold text-foam hover:border-foam-muted ${className}`}
    >
      {value.copy.lang.switchTo}
    </button>
  );
}
