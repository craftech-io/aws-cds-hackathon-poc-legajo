// Language of the authenticated console (docs/adr/0020). The value `lang` is what the person reads now:
// before the server answers it is the visitor's remembered choice (the landing and the access screens
// keep it in the same place) or the browser's language; once `account.preferences` answers, the
// language the account chose on any device replaces it, unless the person already picked one here.
// Picking one in the account menu applies at once, is remembered in this browser and is saved with the
// account (`account.setLanguage`); if saving fails the choice still holds here and a notice says so.
//
// The texts are language-keyed dictionaries whose accessors follow `activeLang()` (copy/localized.ts),
// so this provider sets that value before it renders and remounts the console tree when it changes:
// every view reads its texts again without subscribing to anything. React Context + useState only.
import type { Language } from "@legajo/shared";
import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copy } from "../copy/console";
import { fetchAccountPreferences, saveAccountLanguage } from "../lib/console-api";
import { LANGUAGE_TAGS, setActiveLang } from "../lib/console-lang";
import { initialConsoleLang } from "../lib/preferred-lang";
import { storeLang } from "../views/auth/lang";
import { useSession } from "./SessionContext";

interface ConsoleLangValue {
  readonly lang: Language;
  /** The person's own choice: applied now, remembered here and saved with the account. */
  setLang(lang: Language): void;
}

const ConsoleLangContext = createContext<ConsoleLangValue | undefined>(undefined);

/** The language could not be saved with the account: it holds in this browser only. Above the console, so it outlives the remount. */
function NotSavedNotice({ onDismiss }: { readonly onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-center justify-between gap-4 border-b border-warning bg-warning-soft px-4 py-2.5 text-sm text-warning md:px-6">
      <p>{copy.account.languageNotSaved}</p>
      <button type="button" className="min-h-11 shrink-0 rounded-md px-3 font-semibold underline" onClick={onDismiss}>
        {copy.account.dismiss}
      </button>
    </div>
  );
}

export function ConsoleLangProvider({ children }: { readonly children: ReactNode }) {
  const { trpc, state } = useSession();
  const sub = state.status === "authenticated" ? state.principal.sub : "";
  const [lang, setCurrent] = useState<Language>(initialConsoleLang);
  const [saveFailed, setSaveFailed] = useState(false);
  // Set once the person picks a language here: a late answer of the server must not overwrite it.
  const chosen = useRef(false);
  // Texts are read while the console renders: the language they follow is set before its children render.
  setActiveLang(lang);
  const latest = useRef(lang);
  latest.current = lang;
  // Leaving the console (signing out) leaves the default behind, so the landing and the access screens,
  // which keep their own language, never read the console's.
  useEffect(() => {
    setActiveLang(latest.current);
    return () => setActiveLang("es");
  }, []);

  useEffect(() => {
    if (sub === "") return;
    const controller = new AbortController();
    fetchAccountPreferences(trpc, controller.signal).then(
      ({ language }) => {
        if (controller.signal.aborted || chosen.current || language === null) return;
        storeLang(language);
        setCurrent(language);
      },
      // The preference is a convenience: without it the remembered or the browser's language stays.
      () => undefined,
    );
    return () => controller.abort();
  }, [trpc, sub]);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.lang;
    root.lang = LANGUAGE_TAGS[lang];
    return () => {
      root.lang = previous;
    };
  }, [lang]);

  const setLang = useCallback(
    (next: Language) => {
      chosen.current = true;
      storeLang(next);
      setActiveLang(next);
      setCurrent(next);
      setSaveFailed(false);
      saveAccountLanguage(trpc, next).then(
        () => undefined,
        () => setSaveFailed(true),
      );
    },
    [trpc],
  );

  const value = useMemo<ConsoleLangValue>(() => ({ lang, setLang }), [lang, setLang]);
  return (
    <ConsoleLangContext.Provider value={value}>
      {saveFailed ? <NotSavedNotice onDismiss={() => setSaveFailed(false)} /> : null}
      <Fragment key={lang}>{children}</Fragment>
    </ConsoleLangContext.Provider>
  );
}

export function useConsoleLang(): ConsoleLangValue {
  const value = useContext(ConsoleLangContext);
  if (!value) throw new Error("useConsoleLang must be used inside ConsoleLangProvider");
  return value;
}
