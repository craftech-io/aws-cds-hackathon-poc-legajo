// The landing's own icon set (docs/landing-spec.md §3.6): inline SVG on a 24 px grid, 1.75 stroke,
// round caps and joins, `currentColor`, no fill but the status dot. No third-party logo: the messaging
// channel is a generic chat bubble. Decorative by default (`aria-hidden`); a button whose only content
// is an icon carries its own `aria-label`.
import type { ReactNode } from "react";

const PATHS = {
  document: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M10 12h5M10 16h5" />
    </>
  ),
  documents: (
    <>
      <path d="M9 4h6l4 4v11H9z" />
      <path d="M15 4v4h4M6 7v13h10" />
    </>
  ),
  ship: (
    <>
      <path d="M3 15h18l-2.5 4.5H5.5z" />
      <path d="M6 15V9h12v6M10 9V5h4v4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  eta: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4M9 14.5h6M13 12.5l2 2-2 2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  personCheck: (
    <>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.4 0 2.6.3 3.6 1M15 18l2 2 4-4.5" />
    </>
  ),
  handoff: (
    <>
      <path d="M4 12h12M12 7l5 5-5 5" />
      <path d="M20 5v14" />
    </>
  ),
  envelope: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M4 7l8 6 8-6" />
    </>
  ),
  chat: <path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z" />,
  reader: (
    <>
      <path d="M6 3h7l4 4v5M13 3v4h4M6 3v18h5" />
      <circle cx="16" cy="16.5" r="3" />
      <path d="M18.2 18.7L21 21.5" />
    </>
  ),
  policy: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2L18 18M6 18l1.8-1.8M16.2 7.8L18 6" />
    </>
  ),
  cloud: <path d="M7.5 18.5a4.5 4.5 0 0 1-.6-9 5.5 5.5 0 0 1 10.5 1.5 3.75 3.75 0 0 1-.4 7.5z" />,
  linkBroken: (
    <>
      <path d="M10 14l-1.5 1.5a3.5 3.5 0 0 1-5-5L5 9M14 10l1.5-1.5a3.5 3.5 0 0 1 5 5L19 15" />
      <path d="M8 4l1 2.5M4 8l2.5 1M16 20l-1-2.5M20 16l-2.5-1" />
    </>
  ),
  mask: (
    <>
      <path d="M3.5 8.5c2.5-1.5 5.5-2 8.5-2s6 .5 8.5 2c0 5-3.5 8.5-8.5 8.5S3.5 13.5 3.5 8.5z" />
      <path d="M7.5 11h2.5M14 11h2.5" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  arrowRight: <path d="M4.5 12h15M14 6.5l5.5 5.5-5.5 5.5" />,
  arrowDown: <path d="M12 4.5v15M6.5 14l5.5 5.5 5.5-5.5" />,
  chevronLeft: <path d="M15 5l-7 7 7 7" />,
  chevronRight: <path d="M9 5l7 7-7 7" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  external: <path d="M14 4.5h5.5V10M19.5 4.5L11 13M17 14v5.5H4.5V7H10" />,
  pause: <path d="M9 6v12M15 6v12" />,
  play: <path d="M8 5.5v13l10-6.5z" />,
  enlarge: <path d="M4.5 9.5v-5h5M19.5 14.5v5h-5M4.5 4.5L10 10M19.5 19.5L14 14" />,
  route: <path d="M6 4.5v15M6 8h7a3 3 0 0 1 0 6H9" />,
} satisfies Readonly<Record<string, ReactNode>>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "h-5 w-5" }: { readonly name: IconName; readonly className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`}>
      {PATHS[name]}
    </svg>
  );
}
