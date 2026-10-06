// The hero (docs/landing-spec.md §2.2 and §4.4): who it is for, the value line as the page's only
// `h1` (the LCP element: text, no image), the lead, "Probar Legajo listo" (a full page load of `/signup`),
// "Ingresar" and "Ver cómo funciona", three trust points and the synthetic-data note. Beside it, the
// importer's phone writes the real first request and the delegation to the supplier once (≤ 12 s),
// pausing out of view or in a hidden tab; a visually hidden transcript carries the whole conversation
// from the start, so a screen reader never reads a half-written text.
import { useMemo, useRef } from "react";
import { buttonClass } from "../../components/Button";
import { useSession } from "../../context/SessionContext";
import { useRouter } from "../../lib/router";
import { HERO_ANCHOR, STORY, conversation, heroMessages } from "./conversations";
import { SignInLink } from "./Header";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";
import { signupHref } from "./links";
import { useInView } from "./motion/hooks";
import { useMotion } from "./motion/MotionContext";
import type { ScriptLine } from "./motion/schedule";
import { usePlayback } from "./motion/usePlayback";
import { WhatsAppPhone } from "./WhatsAppPhone";

const MESSAGES = heroMessages();
const SCRIPT: readonly ScriptLine[] = MESSAGES.map((message) => ({ kind: message.from === "firm" ? "firm" : message.tap ? "tap" : "text", text: message.text }));

function HeroConversation() {
  const { hero } = useLandingCopy();
  const { animate } = useMotion();
  const figure = useRef<HTMLDivElement>(null);
  const inView = useInView(figure, { threshold: 0.2 });
  const { frame, replay } = usePlayback(SCRIPT, animate, inView);
  const shown = MESSAGES.slice(0, frame.shown);
  const next = frame.pending ? MESSAGES[frame.pending.index] : undefined;
  const pending = useMemo(() => {
    if (!frame.pending || !next) return undefined;
    if (frame.pending.phase === "highlight") return { phase: "highlight" as const, tapped: next.text };
    if (frame.pending.phase === "writing") return { phase: "writing" as const, partial: next.text.slice(0, frame.pending.chars) };
    return { phase: "typing" as const };
  }, [frame.pending, next]);

  return (
    <div ref={figure} data-hero-visual="" className="flex flex-col items-center gap-4">
      <WhatsAppPhone conversation={conversation("request")} messages={shown} firmName={STORY.firmName} caption={hero.phoneCaption} size="hero" pending={pending} animate={animate} {...(frame.done ? { anchor: HERO_ANCHOR } : {})} decorative />
      <div className="sr-only" lang="es-AR">
        <p>{hero.phoneLabel}</p>
        <ol>
          {MESSAGES.map((message, index) => (
            <li key={index}>{message.text}</li>
          ))}
        </ol>
      </div>
      {animate && frame.done ? (
        <button type="button" onClick={replay} className={buttonClass("ghost-foam")}>
          <Icon name="play" className="h-4 w-4" />
          {hero.replay}
        </button>
      ) : null}
    </div>
  );
}

export function Hero() {
  const { hero, session } = useLandingCopy();
  const { search } = useRouter();
  const { state } = useSession();
  return (
    <section id="top" data-tone="dark" aria-labelledby="hero-title" className="harbor-grid relative overflow-hidden bg-harbor-950 px-gutter pb-section pt-12 text-foam sm:pt-16">
      <div className="relative mx-auto grid max-w-content items-center gap-12 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <p className="text-balance font-display text-eyebrow font-semibold uppercase text-signal">{hero.eyebrow}</p>
          <h1 id="hero-title" className="mt-4 font-display text-display font-semibold text-foam">
            {hero.title}
          </h1>
          <p className="mt-6 max-w-prose text-lead text-foam-muted">{hero.lead}</p>
          <div className="mt-8 flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
            <a href={signupHref(search)} className={buttonClass("primary-signal")}>
              {hero.primary}
              <Icon name="arrowRight" className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.75" />
            </a>
            <SignInLink className={buttonClass("ghost-foam")} />
            <a href="#tour" className={`${buttonClass("link")} text-foam`}>
              {hero.tertiary}
              <Icon name="arrowDown" className="h-4 w-4" />
            </a>
          </div>
          {state.status === "authenticated" ? <p className="mt-3 text-sm text-foam-muted">{session.signedIn}</p> : null}
          <ul className="mt-8 flex flex-col gap-2 text-sm text-foam sm:flex-row sm:flex-wrap sm:gap-x-6">
            {hero.trust.map((point) => (
              <li key={point} className="flex items-center gap-2">
                <Icon name="check" className="h-4 w-4 text-glass" />
                {point}
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-prose text-sm text-foam-muted">{hero.note}</p>
        </div>
        <div className="lg:col-span-5">
          <HeroConversation />
        </div>
      </div>
      <span id="hero-end" aria-hidden="true" className="absolute bottom-0 left-0 h-px w-px" />
    </section>
  );
}
