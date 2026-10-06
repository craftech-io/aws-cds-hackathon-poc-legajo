// The landing's fixed header (docs/landing-spec.md §1.2 and §5.1): "Saltar al contenido" as the first
// focus, the wordmark, the section links from 1280 px (a menu below that: at 1024 px the five links,
// the switch and both calls to action do not fit in one row without a horizontal scroll), the es/en
// switch, "Ingresar"
// and the primary call to action, which is always "Probar Legajo listo" and always a full page load of
// `/signup`. The global "Pausar animaciones" (WCAG 2.2.2) sits here too. Past the hero the header
// shows its bottom border (by opacity, nothing animates its size).
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { buttonClass } from "../../components/Button";
import { LegajoWordmark } from "../../components/brand/Brand";
import { useSession } from "../../context/SessionContext";
import { Link, useRouter } from "../../lib/router";
import { CONSOLE_HOME } from "../../routes";
import { Icon } from "./icons";
import { LangSwitch, useLandingCopy } from "./lang";
import { EXTERNAL_LINK, SIGN_IN_PATH, contactHref, signupHref } from "./links";
import { useMotion } from "./motion/MotionContext";

const SECTION_LINKS = ["tour", "guarantees", "integrations", "architecture", "faq"] as const;

/** "Ingresar" (or `label`), or the console for a visitor already signed in. */
export function SignInLink({ className, label }: { readonly className: string; readonly label?: string }) {
  const { cta } = useLandingCopy();
  const { state } = useSession();
  const signedIn = state.status === "authenticated";
  return (
    <Link to={signedIn ? CONSOLE_HOME : SIGN_IN_PATH} className={`whitespace-nowrap ${className}`}>
      {signedIn ? cta.toConsole : (label ?? cta.signIn)}
    </Link>
  );
}

function PauseButton({ withText }: { readonly withText: boolean }) {
  const { motion } = useLandingCopy();
  const { paused, togglePaused } = useMotion();
  const label = paused ? motion.resume : motion.paused;
  return (
    <button
      type="button"
      aria-pressed={paused}
      aria-label={withText ? undefined : label}
      title={label}
      onClick={togglePaused}
      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-pill border border-harbor-700 px-3 text-sm font-semibold text-foam hover:border-foam-muted"
    >
      <Icon name={paused ? "play" : "pause"} className="h-4 w-4" />
      {withText ? label : null}
    </button>
  );
}

function MenuPanel({ id, onClose }: { readonly id: string; readonly onClose: () => void }) {
  const { nav, cta } = useLandingCopy();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, []);

  // While open the menu keeps the focus inside it; Escape closes it (the button gets the focus back).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(panel.current?.querySelectorAll<HTMLElement>("a, button") ?? [])];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div id={id} ref={panel} onKeyDown={onKeyDown} className="border-t border-harbor-800 bg-harbor-950 px-gutter pb-5 xl:hidden">
      <nav aria-label={nav.label}>
        <ul className="flex flex-col py-2">
          {SECTION_LINKS.map((anchor) => (
            <li key={anchor}>
              <a href={`#${anchor}`} onClick={onClose} className="flex min-h-11 items-center text-base font-semibold text-foam hover:text-signal">
                {nav[anchor]}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-wrap items-center gap-3 border-t border-harbor-800 pt-4">
        <LangSwitch className="md:hidden" />
        <SignInLink className="inline-flex min-h-11 items-center px-1 text-base font-semibold text-foam underline-offset-4 hover:underline md:hidden" />
        <PauseButton withText />
        <a href={contactHref("header")} {...EXTERNAL_LINK} title={cta.talkHint} className="inline-flex min-h-11 items-center gap-1.5 px-1 text-base font-semibold text-foam underline-offset-4 hover:underline">
          {cta.talk}
          <Icon name="external" className="h-4 w-4" />
          <span className="sr-only">{cta.newTab}</span>
        </a>
      </div>
    </div>
  );
}

export function Header() {
  const { nav, cta } = useLandingCopy();
  const { search } = useRouter();
  const [open, setOpen] = useState(false);
  const [past, setPast] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // The border appears once the hero has scrolled away (one observer on the hero's sentinel).
  useEffect(() => {
    const sentinel = document.getElementById("hero-end");
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setPast(!(entry?.isIntersecting ?? true)));
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const closeMenu = () => {
    setOpen(false);
    menuButton.current?.focus();
  };

  return (
    <header data-tone="dark" className="sticky top-0 z-40 bg-harbor-950/95 backdrop-blur">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-pill focus:bg-signal focus:px-4 focus:text-harbor-950">
        {nav.skip}
      </a>
      <div className="mx-auto flex h-16 max-w-content items-center gap-3 px-gutter">
        <a href="#top" className="mr-auto inline-flex min-h-11 shrink-0 items-center" aria-label="SIDOM Legajo listo">
          <LegajoWordmark tone="dark" size="lg" />
        </a>
        <nav aria-label={nav.label} className="hidden xl:block">
          <ul className="flex items-center gap-1">
            {SECTION_LINKS.map((anchor) => (
              <li key={anchor}>
                <a href={`#${anchor}`} className="inline-flex min-h-11 items-center whitespace-nowrap rounded-pill px-2.5 text-sm font-semibold text-foam-muted hover:text-foam">
                  {nav[anchor]}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <LangSwitch className="hidden md:inline-flex" />
        <div className="hidden xl:block">
          <PauseButton withText={false} />
        </div>
        <SignInLink className="hidden min-h-11 items-center px-2 text-sm font-semibold text-foam underline-offset-4 hover:underline md:inline-flex" />
        <a href={signupHref(search)} aria-label={cta.try} className={buttonClass("primary-signal")}>
          <span className="whitespace-nowrap 2xl:hidden">{cta.tryShort}</span>
          <span className="hidden whitespace-nowrap 2xl:inline">{cta.try}</span>
        </a>
        <button
          ref={menuButton}
          type="button"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => (open ? closeMenu() : setOpen(true))}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill border border-harbor-700 text-foam xl:hidden"
        >
          <Icon name={open ? "cross" : "menu"} />
          <span className="sr-only">{nav.menu}</span>
        </button>
      </div>
      <span aria-hidden="true" className={`block h-px bg-harbor-700 transition-opacity duration-300 ${past ? "opacity-100" : "opacity-0"}`} />
      {open ? <MenuPanel id={menuId} onClose={closeMenu} /> : null}
    </header>
  );
}
