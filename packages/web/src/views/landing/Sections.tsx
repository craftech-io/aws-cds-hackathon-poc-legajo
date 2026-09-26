// The content sections of the landing: the problem, what is real and what is simulated
// (docs/design-brief.md §7.2), what does not depend on the model, the console, the judges' entry and
// the demo video. Each one reads its texts from copy in the page's language.
import type { ReactNode } from "react";
import { useSession } from "../../context/SessionContext";
import { Link } from "../../lib/router";
import { CONSOLE_HOME, LOGIN_PATH } from "../../routes";
import { useLandingCopy } from "./lang";
import { MediaFigure } from "./MediaFigure";
import { CONSOLE_CAPTURE_IDS } from "./manifest";
import { type MediaState, mediaIdsOf } from "./media";

type Tone = "light" | "white" | "dark";

const BACKGROUND: Readonly<Record<Tone, string>> = { light: "bg-paper", white: "bg-white", dark: "bg-navy text-white" };

export function LandingSection({ id, eyebrow, title, lead, tone = "light", children }: { readonly id?: string; readonly eyebrow?: string; readonly title: string; readonly lead?: string; readonly tone?: Tone; readonly children: ReactNode }) {
  const dark = tone === "dark";
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={`scroll-mt-20 px-4 py-16 sm:px-8 sm:py-20 ${BACKGROUND[tone]}`}>
      <div className="mx-auto max-w-6xl">
        {eyebrow ? <p className={`text-xs font-semibold uppercase tracking-widest ${dark ? "text-cyan" : "text-cyan-deep"}`}>{eyebrow}</p> : null}
        <h2 id={id ? `${id}-title` : undefined} className={`mt-2 max-w-3xl text-3xl font-semibold leading-tight sm:text-4xl ${dark ? "text-white" : "text-navy"}`}>
          {title}
        </h2>
        {lead ? <p className={`mt-4 max-w-3xl text-lg ${dark ? "text-mist" : "text-slate"}`}>{lead}</p> : null}
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}

/** The judges' entry: the login, or the console for a visitor already signed in. */
export function JudgesButton({ onDark = false }: { readonly onDark?: boolean }) {
  const { cta } = useLandingCopy();
  const { state } = useSession();
  const signedIn = state.status === "authenticated";
  return (
    <Link
      to={signedIn ? CONSOLE_HOME : LOGIN_PATH}
      className={`inline-flex items-center justify-center rounded-md px-5 py-3 text-sm font-semibold transition-colors ${onDark ? "bg-cyan text-navy-deep hover:bg-white" : "bg-navy text-white hover:bg-navy-soft"}`}
    >
      {signedIn ? cta.goToConsole : cta.judges} →
    </Link>
  );
}

export function ProblemSection() {
  const { problem, nav } = useLandingCopy();
  return (
    <LandingSection id="problem" eyebrow={nav.problem} title={problem.title} lead={problem.lead} tone="white">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {problem.items.map((item, index) => (
          <article key={item.title} className="rounded-card border border-mist bg-paper p-6">
            <p className="text-sm font-semibold text-cyan-deep">0{index + 1}</p>
            <h3 className="mt-2 text-lg font-semibold text-navy">{item.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate">{item.text}</p>
          </article>
        ))}
      </div>
    </LandingSection>
  );
}

export function RealSection() {
  const { real, nav } = useLandingCopy();
  return (
    <LandingSection id="real" eyebrow={nav.real} title={real.title} tone="white">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Object.entries(real.columns).map(([key, column]) => (
          <article key={key} className="rounded-card border border-mist bg-paper p-5">
            <h3 className="text-sm font-semibold text-navy">{column.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate">{column.text}</p>
          </article>
        ))}
      </div>
    </LandingSection>
  );
}

export function HowSection() {
  const { how } = useLandingCopy();
  return (
    <LandingSection id="how" eyebrow={how.eyebrow} title={how.title} lead={how.lead} tone="dark">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {how.items.map((item) => (
          <article key={item.title} className="rounded-card border border-navy-soft bg-navy-deep p-6">
            <h3 className="text-lg font-semibold text-white">{item.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-mist">{item.text}</p>
          </article>
        ))}
      </div>
    </LandingSection>
  );
}

export function ConsoleSection({ media }: { readonly media: MediaState }) {
  const copy = useLandingCopy();
  const present = mediaIdsOf(media);
  const captures = present.filter((id) => CONSOLE_CAPTURE_IDS.includes(id));
  const renders = present.filter((id) => !CONSOLE_CAPTURE_IDS.includes(id));
  return (
    <LandingSection id="console" eyebrow={copy.console.eyebrow} title={copy.console.title} lead={copy.console.lead}>
      {captures.length > 0 ? (
        <div className="grid gap-6 md:grid-cols-2">
          {captures.map((id) => (
            <MediaFigure key={id} media={media} id={id} captioned />
          ))}
        </div>
      ) : media.status === "ready" ? (
        <p className="max-w-3xl rounded-card border border-mist bg-white px-4 py-3 text-sm text-slate">{copy.console.pending}</p>
      ) : null}
      {renders.length > 0 ? (
        <>
          <h3 className="mt-10 text-lg font-semibold text-navy">{copy.console.uploadTitle}</h3>
          <div className="mt-4 grid items-start gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {renders.map((id) => (
              <MediaFigure key={id} media={media} id={id} captioned />
            ))}
          </div>
        </>
      ) : null}
    </LandingSection>
  );
}

export function JudgesSection() {
  const { judges } = useLandingCopy();
  return (
    <LandingSection id="judges" eyebrow={judges.eyebrow} title={judges.title} lead={judges.lead} tone="white">
      <div className="flex flex-col gap-8 rounded-card bg-navy p-8 text-white sm:p-10 lg:flex-row lg:items-center lg:justify-between">
        <ol className="max-w-2xl list-decimal space-y-2 pl-5 text-mist">
          {judges.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="flex flex-col gap-3 lg:max-w-xs">
          <JudgesButton onDark />
          <p className="text-xs text-cyan-soft">{judges.credentials}</p>
        </div>
      </div>
    </LandingSection>
  );
}

/** Renders nothing until the manifest names a video file (public/landing/manifest.json). */
export function VideoSlot({ media }: { readonly media: MediaState }) {
  const { video } = useLandingCopy();
  if (media.status !== "ready" || media.manifest.video === null) return null;
  const clip = media.manifest.video;
  return (
    <LandingSection id="video" title={video.title} tone="white">
      <figure className="mx-auto max-w-4xl">
        <video controls preload="none" playsInline className="aspect-video w-full rounded-card bg-navy shadow-card" src={clip.src} {...(clip.poster ? { poster: clip.poster } : {})} />
        {clip.caption ? <figcaption className="mt-2 text-sm text-slate">{clip.caption}</figcaption> : null}
      </figure>
    </LandingSection>
  );
}
