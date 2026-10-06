// Frame of every access screen (docs/landing-spec.md §8.1): the brand panel on the dark harbour band
// (wordmark, value line, three points of trust, "Powered by Craftech") and the form card on the
// light paper, the es/en switch and the way back to the landing. Below 1024 px the brand panel shrinks
// to a strip with the wordmark. Legal links in the footer, in the page's language.
import { legalPageHref } from "@legajo/shared/consent-texts";
import type { ReactNode } from "react";
import { LegajoWordmark, PoweredByCraftech } from "../../components/brand/Brand";
import { LangToggle } from "../../components/LangToggle";
import { Link } from "../../lib/router";
import { LANDING_PATH } from "../../routes";
import { useAuthLang } from "./AuthLang";
import { hrefWithLang } from "./lang";

function BrandPanel() {
  const { copy } = useAuthLang();
  return (
    <section className="relative flex flex-col justify-between gap-10 overflow-hidden bg-harbor-950 px-gutter py-5 text-foam lg:min-h-screen lg:px-12 lg:py-12">
      <div className="relative">
        <LegajoWordmark tone="dark" size="lg" />
        <p className="mt-2 hidden text-sm text-foam-muted lg:block">{copy.layout.tagline}</p>
      </div>
      <div className="relative hidden max-w-md lg:block">
        <p className="font-display text-h2 font-semibold">{copy.layout.title}</p>
        <p className="mt-4 text-base text-foam-muted">{copy.layout.lead}</p>
        <ul className="mt-6 space-y-2 text-sm text-foam">
          {copy.layout.points.map((point) => (
            <li key={point} className="flex items-center gap-2">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-pill bg-glass" />
              {point}
            </li>
          ))}
        </ul>
      </div>
      <div className="relative hidden lg:block">
        <PoweredByCraftech tone="dark" />
      </div>
    </section>
  );
}

function LangSwitch() {
  const { lang, copy, setLang } = useAuthLang();
  return <LangToggle lang={lang} label={copy.lang.label} onChange={setLang} tone="light" />;
}

export function AuthLayout({ children }: { readonly children: ReactNode }) {
  const { lang, copy } = useAuthLang();
  return (
    <div data-surface="public" className="min-h-screen bg-manifest text-ink lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <BrandPanel />
      <main id="main" className="flex flex-col items-center px-gutter py-8 lg:justify-center lg:py-12">
        <div className="flex w-full max-w-auth items-center justify-between gap-3">
          <Link to={hrefWithLang(LANDING_PATH, lang)} className="inline-flex min-h-11 items-center text-sm font-semibold text-signal-ink underline-offset-4 hover:underline">
            {copy.layout.backHome}
          </Link>
          <LangSwitch />
        </div>
        <div className="mt-4 w-full max-w-auth rounded-panel bg-white p-6 shadow-raised sm:p-8">{children}</div>
        <footer className="mt-8 flex w-full max-w-auth flex-col items-center gap-3 text-xs text-ink-muted">
          <PoweredByCraftech tone="light" className="lg:hidden" />
          <nav className="flex gap-2">
            <a className="inline-flex min-h-11 items-center px-2 hover:text-ink hover:underline" href={legalPageHref("privacy", lang)}>
              {copy.layout.privacy}
            </a>
            <a className="inline-flex min-h-11 items-center px-2 hover:text-ink hover:underline" href={legalPageHref("terms", lang)}>
              {copy.layout.terms}
            </a>
          </nav>
        </footer>
      </main>
    </div>
  );
}
