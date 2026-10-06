// The language selector of the public pages: a globe and "ES | EN", the current language filled in, so
// the control says which language the page is in (and not which one it would switch to). Two buttons
// in a labelled group, each `aria-pressed` / `aria-current`, each a 44 px target, reachable and operable
// with the keyboard like any button. `dark` sits on the landing's harbour header, `light` on paper.
import type { Language } from "@legajo/shared";

function Globe() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="ml-3 mr-1 h-4 w-4 shrink-0">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.2 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.2-3.3-8.5s1.1-6.1 3.3-8.5z" />
    </svg>
  );
}

const OPTIONS: ReadonlyArray<{ readonly code: Language; readonly short: string; readonly name: string; readonly htmlLang: string }> = [
  { code: "es", short: "ES", name: "Español", htmlLang: "es-AR" },
  { code: "en", short: "EN", name: "English", htmlLang: "en" },
];

const TONES = {
  dark: { group: "border-harbor-700 text-foam-muted", active: "bg-signal text-harbor-950", idle: "hover:text-foam" },
  light: { group: "border-rule text-ink-muted", active: "bg-harbor-950 text-foam", idle: "hover:text-ink" },
} as const;

interface LangToggleProps {
  readonly lang: Language;
  /** The group's accessible name ("Idioma" / "Language"). */
  readonly label: string;
  readonly onChange: (lang: Language) => void;
  readonly tone: keyof typeof TONES;
  /** `className` carries the display (`inline-flex` by default): two display utilities on one element have no reliable winner. */
  readonly className?: string;
}

export function LangToggle({ lang, label, onChange, tone, className = "inline-flex" }: LangToggleProps) {
  const colors = TONES[tone];
  return (
    <div role="group" aria-label={label} className={`shrink-0 items-center overflow-hidden rounded-pill border ${colors.group} ${className}`}>
      <Globe />
      {OPTIONS.map((option) => {
        const active = option.code === lang;
        return (
          <button
            key={option.code}
            type="button"
            lang={option.htmlLang}
            aria-label={option.name}
            aria-pressed={active}
            {...(active ? { "aria-current": "true" as const } : {})}
            onClick={() => (active ? undefined : onChange(option.code))}
            className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill px-2.5 text-sm font-semibold ${active ? colors.active : colors.idle}`}
          >
            {option.short}
          </button>
        );
      })}
    </div>
  );
}
