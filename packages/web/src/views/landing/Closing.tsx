// The closing call to action and the footer (docs/landing-spec.md §1.10, §2.11 and §9): "Probar la
// demo" (a full page load of `/signup`), "Ya tengo cuenta: ingresar", and "Hablemos" to Craftech's
// contact page in a new tab with sales@craftech.io as the alternative; then "Legajo listo · Powered by
// Craftech", the legal pages, the synthetic-data notice and the contact address. One version only:
// the same title, lead and primary call to action on every stage.
import { buttonClass } from "../../components/Button";
import { LegajoWordmark, PoweredByCraftech } from "../../components/brand/Brand";
import { useRouter } from "../../lib/router";
import { SignInLink } from "./Header";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";
import { EXTERNAL_LINK, SALES_EMAIL, SALES_MAILTO, contactHref, signupHref } from "./links";

export function ClosingSection() {
  const { closing, cta } = useLandingCopy();
  const { search } = useRouter();
  return (
    <section id="start" data-tone="dark" aria-labelledby="start-title" className="bg-harbor-950 px-gutter py-section text-foam">
      <div className="mx-auto grid max-w-content gap-10 lg:grid-cols-12 lg:items-center">
        <div data-reveal="" className="lg:col-span-7">
          <h2 id="start-title" className="font-display text-h2 font-semibold">
            {closing.title}
          </h2>
          <p className="mt-4 max-w-prose text-lead text-foam-muted">{closing.lead}</p>
          <div className="mt-8 flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
            <a href={signupHref(search)} className={buttonClass("primary-signal")}>
              {closing.try}
              <Icon name="arrowRight" className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.75" />
            </a>
            <SignInLink className={buttonClass("ghost-foam")} label={closing.signIn} />
          </div>
        </div>
        <div data-reveal="" className="rounded-panel border border-harbor-700 bg-harbor-900 p-6 lg:col-span-5">
          <h3 className="font-display text-h3 font-semibold">{closing.talkTitle}</h3>
          <p className="mt-2 text-base text-foam-muted">{closing.talkLead}</p>
          <a href={contactHref("closing")} {...EXTERNAL_LINK} title={cta.talkHint} className={`${buttonClass("ghost-foam")} mt-5 w-full sm:w-auto`}>
            {closing.talk}
            <Icon name="external" className="h-4 w-4" />
            <span className="sr-only">{cta.newTab}</span>
          </a>
          <p className="mt-3 text-sm text-foam-muted">
            <a href={SALES_MAILTO} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-foam">
              {closing.talkAlt}
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  const { footer, cta } = useLandingCopy();
  return (
    <footer data-tone="dark" className="border-t border-harbor-800 bg-harbor-950 px-gutter py-10 text-foam-muted">
      <div className="mx-auto flex max-w-content flex-col gap-6 text-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <LegajoWordmark tone="dark" size="md" />
            <span aria-hidden="true" className="h-4 w-px bg-harbor-700" />
            <PoweredByCraftech tone="dark" />
          </p>
          <p className="sr-only">{footer.product}</p>
          <p>{footer.synthetic}</p>
          <p>{footer.rights}</p>
        </div>
        <nav aria-label={footer.legal} className="flex flex-wrap items-center gap-x-5">
          <a href="/legal/privacy.html" className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-foam hover:underline">
            {footer.privacy}
          </a>
          <a href="/legal/terms.html" className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-foam hover:underline">
            {footer.terms}
          </a>
          <a href={SALES_MAILTO} className="inline-flex min-h-11 items-center hover:text-foam hover:underline">
            {footer.contact}: {SALES_EMAIL}
          </a>
          <a href={contactHref("footer")} {...EXTERNAL_LINK} title={cta.talkHint} className="inline-flex min-h-11 items-center gap-1 hover:text-foam hover:underline">
            {cta.talk}
            <Icon name="external" className="h-3.5 w-3.5" />
            <span className="sr-only">{cta.newTab}</span>
          </a>
        </nav>
      </div>
    </footer>
  );
}
