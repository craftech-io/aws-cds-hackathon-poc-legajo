// The console's activity indicator: a ring that turns while something is on its way. Decorative
// (`aria-hidden`): the element that waits says so itself (`role="status"`, `aria-busy`). With
// `prefers-reduced-motion` it stops turning and pulses its opacity instead, so it still reads as busy.
interface SpinnerProps {
  /** `sm` sits inside a button or a line of text; `md` heads a loading block. */
  readonly size?: "sm" | "md";
}

const SIZES = { sm: "size-4 border-2", md: "size-6 border-3" } as const;

export function Spinner({ size = "sm" }: SpinnerProps) {
  return <span aria-hidden="true" className={`inline-block shrink-0 rounded-full border-current border-r-transparent motion-safe:animate-spin motion-reduce:animate-pulse ${SIZES[size]}`} />;
}
