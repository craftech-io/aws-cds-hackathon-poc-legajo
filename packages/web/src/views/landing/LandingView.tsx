// `/`: the public welcome page of the demo, "Legajo listo · Powered by Craftech", in Spanish or
// English (docs/design-brief.md §7). No login: it tells the problem and the story of operation 4471
// with the real texts of the product, says what is real and what is simulated, shows the console and
// the architecture, and offers the sign-in. A signed-in visitor still lands here, with the call to
// action pointing to the console.
import { BrandLine, LegajoWordmark, PoweredByCraftech } from "../../components/brand/Brand";
import { useRouter } from "../../lib/router";
import { ArchitectureSection } from "./Architecture";
import { STORY, conversation } from "./conversations";
import { DemoScenes } from "./DemoScenes";
import { GalleryProvider } from "./gallery";
import { LandingLangProvider, langFromSearch, useLandingCopy, useLandingLang } from "./lang";
import { type MediaState, useLandingMedia } from "./media";
import { ConsoleSection, HowSection, LandingSection, ProblemSection, RealSection, SignInButton, VideoSlot } from "./Sections";
import { WhatsAppPhone } from "./WhatsAppPhone";

function LangSwitch() {
  const value = useLandingLang();
  if (!value) return null;
  const next = value.lang === "es" ? "en" : "es";
  return (
    <button
      type="button"
      lang={next === "en" ? "en" : "es-AR"}
      aria-label={value.copy.lang.switchLabel}
      onClick={() => value.setLang(next)}
      className="rounded-md border border-mist px-3 py-1.5 text-xs font-semibold text-navy hover:bg-paper"
    >
      {value.copy.lang.switchTo}
    </button>
  );
}

function Header() {
  const { nav } = useLandingCopy();
  const links = [
    { href: "#story", label: nav.story },
    { href: "#real", label: nav.real },
    { href: "#how", label: nav.how },
    { href: "#console", label: nav.console },
    { href: "#architecture", label: nav.architecture },
  ];
  return (
    <header className="sticky top-0 z-30 border-b border-mist bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
        <BrandLine tone="light" size="sm" />
        <nav aria-label={nav.label} className="hidden items-center gap-5 text-sm font-medium text-slate xl:flex">
          {links.map((link) => (
            <a key={link.href} href={link.href} className="hover:text-navy">
              {link.label}
            </a>
          ))}
        </nav>
        <LangSwitch />
      </div>
    </header>
  );
}

function Hero() {
  const { hero } = useLandingCopy();
  return (
    <section className="relative overflow-hidden bg-navy px-4 py-16 text-white sm:px-8 sm:py-24">
      <div aria-hidden="true" className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-navy-soft/70" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 left-1/3 h-96 w-96 rounded-full bg-cyan/10" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-cyan">{hero.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight sm:text-5xl">{hero.title}</h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-mist">{hero.lead}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <SignInButton onDark />
            <a href="#story" className="inline-flex items-center justify-center rounded-md border border-navy-soft px-5 py-3 text-sm font-semibold text-white hover:bg-navy-soft">
              {hero.story}
            </a>
          </div>
          <p className="mt-8 max-w-xl text-xs text-cyan-soft">{hero.note}</p>
        </div>
        <WhatsAppPhone conversation={conversation("request")} firmName={STORY.firmName} limit={1} className="text-left" onDark />
      </div>
    </section>
  );
}

function StorySection({ media }: { readonly media: MediaState }) {
  const { story } = useLandingCopy();
  return (
    <LandingSection id="story" eyebrow={story.eyebrow} title={story.title} lead={story.lead}>
      <DemoScenes media={media} />
    </LandingSection>
  );
}

function Footer() {
  const { footer } = useLandingCopy();
  return (
    <footer className="border-t border-mist bg-white px-4 py-8 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 text-sm text-slate md:flex-row md:items-center md:justify-between">
        <LegajoWordmark tone="light" size="md" />
        <div className="max-w-md space-y-1 text-xs">
          <p>{footer.made}</p>
          <p>{footer.synthetic}</p>
        </div>
        <nav aria-label={footer.legal} className="flex flex-wrap items-center gap-4 text-xs">
          <a href="/legal/privacy.html" className="hover:text-navy hover:underline">
            {footer.privacy}
          </a>
          <a href="/legal/terms.html" className="hover:text-navy hover:underline">
            {footer.terms}
          </a>
          <PoweredByCraftech tone="light" />
        </nav>
      </div>
    </footer>
  );
}

export function LandingView() {
  const { search } = useRouter();
  const media = useLandingMedia();
  return (
    <LandingLangProvider initial={langFromSearch(search)}>
      <GalleryProvider media={media}>
        <div className="min-h-screen bg-paper text-ink">
          <Header />
          <main>
            <Hero />
            <ProblemSection />
            <StorySection media={media} />
            <RealSection />
            <HowSection />
            <ConsoleSection media={media} />
            <ArchitectureSection />
            <VideoSlot media={media} />
          </main>
          <Footer />
        </div>
      </GalleryProvider>
    </LandingLangProvider>
  );
}
