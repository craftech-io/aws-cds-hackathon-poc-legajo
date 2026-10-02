// Brand of the product: the "Legajo listo" wordmark (text, no logo file) and a discreet
// "Powered by Craftech" with Craftech's logo. Logo files live in public/brand/ (light backgrounds:
// color SVG; dark: white SVG); every mark falls back to text. No other brand appears anywhere
// (docs/design-brief.md §9, ADR-0006).
import { BrandImage } from "./BrandImage";

export type BrandTone = "light" | "dark";

export const BRAND_ASSETS = {
  craftech: { light: "/brand/logo-craftech-color.svg", dark: "/brand/logo-craftech-blanco.svg" },
} as const;

export const CRAFTECH_URL = "https://craftech.io";

type Size = "sm" | "md" | "lg" | "xl";

const WORDMARK_TEXT: Readonly<Record<Size, string>> = { sm: "text-sm", md: "text-base", lg: "text-lg", xl: "text-3xl" };

/** The product: "Legajo listo". */
export function LegajoWordmark({ tone, size = "md" }: { readonly tone: BrandTone; readonly size?: Size }) {
  return (
    <span className={`whitespace-nowrap font-bold tracking-tight ${WORDMARK_TEXT[size]} ${tone === "dark" ? "text-white" : "text-navy"}`}>
      Legajo <span className={tone === "dark" ? "text-cyan" : "text-cyan-deep"}>listo</span>
    </span>
  );
}

/**
 * "Powered by" + the Craftech logo, linking to craftech.io. Hover darkens (light) or brightens (dark)
 * the text and underlines it, never fades it: small text keeps its AA contrast in every state.
 */
export function PoweredByCraftech({ tone, className = "" }: { readonly tone: BrandTone; readonly className?: string }) {
  const fallback = <span className={`font-bold ${tone === "dark" ? "text-white" : "text-craftech"}`}>Craftech</span>;
  return (
    <a
      href={CRAFTECH_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-11 items-center gap-2 text-xs underline-offset-2 transition-colors hover:underline ${tone === "dark" ? "text-mist hover:text-white" : "text-slate hover:text-ink"} ${className}`}
    >
      <span>Powered by</span>
      <BrandImage src={BRAND_ASSETS.craftech[tone]} alt="Craftech" className="h-5 w-auto" fallback={fallback} />
    </a>
  );
}

/** "Legajo listo · Powered by Craftech", the public brand line. */
export function BrandLine({ tone, size = "md" }: { readonly tone: BrandTone; readonly size?: Size }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <LegajoWordmark tone={tone} size={size} />
      <span aria-hidden="true" className={`h-5 w-px ${tone === "dark" ? "bg-navy-soft" : "bg-mist"}`} />
      <PoweredByCraftech tone={tone} />
    </span>
  );
}
