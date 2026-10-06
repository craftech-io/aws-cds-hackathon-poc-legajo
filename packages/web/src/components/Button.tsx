// The console's button and the public surfaces' variants (docs/landing-spec.md §3.7): the signal CTA
// on dark, the foam ghost on dark and the plain link. A call to action that navigates is an `<a>`
// (the sign-up must be a full page load, ADR-0015 §3.3), so `buttonClass` gives a link the same look.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "primary-signal" | "ghost-foam" | "secondary-ink" | "link";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  /** The action it started is running: shows a spinner, sets `aria-busy` and disables the button. */
  readonly busy?: boolean;
  readonly children: ReactNode;
}

const CONSOLE = "min-h-11 rounded-md px-4 py-2 text-sm transition-colors";
/** Public variants: at least 44 px tall (touch targets, landing-spec §5.1), pill-shaped, a soft press. */
const PUBLIC = "min-h-11 rounded-pill px-5 py-2.5 text-base transition-[transform,background-color,color,border-color] duration-150 active:scale-98";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: `${CONSOLE} bg-cyan text-navy-deep hover:bg-cyan-deep hover:text-white`,
  secondary: `${CONSOLE} border border-mist bg-white text-navy hover:bg-paper`,
  ghost: `${CONSOLE} text-navy hover:bg-mist`,
  danger: `${CONSOLE} bg-danger text-white hover:bg-danger/90`,
  "primary-signal": `${PUBLIC} group bg-signal text-harbor-950 hover:bg-foam`,
  "ghost-foam": `${PUBLIC} border border-harbor-700 text-foam hover:border-foam-muted hover:bg-harbor-800`,
  "secondary-ink": `${PUBLIC} border border-rule bg-white text-ink hover:border-ink-muted`,
  link: "min-h-11 px-1 text-base underline-offset-4 transition-colors hover:underline",
};

/** Classes of a variant, for an `<a>` that has to look like this button. */
export function buttonClass(variant: ButtonVariant): string {
  return `inline-flex items-center justify-center gap-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]}`;
}

export function Button({ variant = "primary", type = "button", busy = false, disabled, children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant)} disabled={busy || disabled} aria-busy={busy || undefined} {...rest}>
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}
