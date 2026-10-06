// A titled block of a view, and the bar that jumps between the blocks of a long view (the dossier:
// documents, timeline, pendings). Every block stays rendered: the bar only scrolls, so what a block shows never depends
// on having clicked it first. `SectionShell` is the same idea for the public landing: a full-width band
// with eyebrow, title and lead in one of three tones (docs/landing-spec.md §3.7).
import type { ReactNode } from "react";

export type SectionTone = "dark" | "light" | "alt";

const SHELL_TONES: Readonly<Record<SectionTone, { readonly band: string; readonly eyebrow: string; readonly title: string; readonly lead: string }>> = {
  dark: { band: "bg-harbor-950 text-foam", eyebrow: "text-signal", title: "text-foam", lead: "text-foam-muted" },
  light: { band: "bg-manifest text-ink", eyebrow: "text-signal-ink", title: "text-ink", lead: "text-ink-muted" },
  alt: { band: "bg-manifest-deep text-ink", eyebrow: "text-signal-ink", title: "text-ink", lead: "text-ink-muted" },
};

interface SectionShellProps {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly lead?: string;
  readonly tone: SectionTone;
  /** Wider container (the product tour). */
  readonly wide?: boolean;
  readonly children: ReactNode;
}

export function SectionShell({ id, eyebrow, title, lead, tone, wide = false, children }: SectionShellProps) {
  const colors = SHELL_TONES[tone];
  return (
    <section id={id} aria-labelledby={`${id}-title`} data-tone={tone === "dark" ? "dark" : "light"} className={`px-gutter py-section ${colors.band}`}>
      <div className={`mx-auto ${wide ? "max-w-tour" : "max-w-content"}`}>
        <div data-reveal="" className="max-w-prose">
          <p className={`text-balance font-display text-eyebrow font-semibold uppercase ${colors.eyebrow}`}>{eyebrow}</p>
          <h2 id={`${id}-title`} className={`mt-3 font-display text-h2 font-semibold ${colors.title}`}>
            {title}
          </h2>
          {lead ? <p className={`mt-4 text-lead ${colors.lead}`}>{lead}</p> : null}
        </div>
        <div className="mt-10 sm:mt-12">{children}</div>
      </div>
    </section>
  );
}

interface SectionProps {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

export function Section({ id, title, description, actions, children }: SectionProps) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-6 rounded-card border border-mist bg-white p-5 shadow-card">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-lg font-semibold text-navy">
            {title}
          </h2>
          {description ? <p className="mt-1 max-w-3xl text-sm text-slate">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export interface SectionLink {
  readonly id: string;
  readonly label: string;
}

export function SectionNav({ label, links }: { readonly label: string; readonly links: readonly SectionLink[] }) {
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <nav aria-label={label} className="sticky top-0 z-10 -mx-6 mb-6 border-b border-mist bg-paper/95 px-6 py-2 backdrop-blur">
      <ul className="flex flex-wrap gap-1">
        {links.map((link) => (
          <li key={link.id}>
            <button type="button" className="rounded-md px-3 py-1.5 text-sm font-medium text-navy hover:bg-mist" onClick={() => jump(link.id)}>
              {link.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
