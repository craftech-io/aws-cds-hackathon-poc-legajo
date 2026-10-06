// The connected architecture diagram of "Cómo funciona por dentro": the picture the README carries
// (docs/assets/architecture/architecture.html, rendered for the public landing in both languages by
// scripts/diagram/render-architecture-public.ts), with a link to open it full size. On a phone the
// picture keeps a readable width inside a scrollable region instead of shrinking to nothing; the
// width and height of the file are declared so it takes its place before it loads.
import { Icon } from "./icons";
import { useLandingCopy, useLandingLang } from "./lang";

const DIAGRAM = { width: 1920, height: 1380, full: 3840 } as const;
const diagramSrc = (lang: string, width: number) => `/landing/architecture/architecture-${lang}-${width}.webp`;

export function ArchitectureDiagram() {
  const { architecture, cta } = useLandingCopy();
  const lang = useLandingLang()?.lang ?? "es";
  return (
    <figure id="architecture-diagram" className="scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h3 className="font-display text-h3 font-semibold text-foam">{architecture.diagram.title}</h3>
        <a href={diagramSrc(lang, DIAGRAM.full)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-harbor-700 px-4 text-sm font-semibold text-foam hover:border-foam-muted">
          <Icon name="enlarge" className="h-4 w-4" />
          {architecture.diagram.open}
          <span className="sr-only">{cta.newTab}</span>
        </a>
      </div>
      <div role="region" aria-label={architecture.diagram.title} tabIndex={0} className="mt-4 overflow-x-auto overscroll-x-contain rounded-panel border border-harbor-700 bg-white shadow-float [scrollbar-width:thin]">
        <img
          src={diagramSrc(lang, DIAGRAM.width)}
          srcSet={`${diagramSrc(lang, DIAGRAM.width)} ${DIAGRAM.width}w, ${diagramSrc(lang, DIAGRAM.full)} ${DIAGRAM.full}w`}
          sizes="(min-width: 768px) 72rem, 64rem"
          width={DIAGRAM.width}
          height={DIAGRAM.height}
          loading="lazy"
          decoding="async"
          alt={architecture.diagram.alt}
          className="block h-auto w-full min-w-256 md:min-w-0"
        />
      </div>
      <figcaption className="mt-3 text-sm text-foam-muted">
        {architecture.diagram.caption} <span className="md:hidden">{architecture.diagram.scrollHint}.</span>
      </figcaption>
    </figure>
  );
}
