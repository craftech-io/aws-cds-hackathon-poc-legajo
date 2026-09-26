// Small builders shared by the Spanish pack, the English texts and the gloss. No `Intl` and no
// `toLocale*`: the seed imports these texts and must write the same bytes on every machine.

/** Public brand (ADR-0006). If it ever changes, this line, the subdomain and the SES identity change. */
export const PRODUCT_NAME = "Legajo listo";

const PLACEHOLDER = /\{\{(\d+)\}\}/g;

/** Characters as WhatsApp counts them (code points, so "ó" or "•" is one). */
export function charCount(text: string): number {
  return [...text].length;
}

/** Placeholder numbers of a template body in order of appearance: "{{1}} … {{2}}" → [1, 2]. */
export function placeholderNumbers(body: string): number[] {
  return [...body.matchAll(PLACEHOLDER)].map((match) => Number(match[1]));
}

/**
 * Fills `{{1}}`…`{{n}}` with `params[0]`…`params[n-1]`. Throws when a placeholder has no value or a
 * value has no placeholder: a template rendered with the wrong arity must never be sent.
 */
export function fillPlaceholders(body: string, params: readonly string[]): string {
  const used = new Set(placeholderNumbers(body));
  if (used.size !== params.length || params.some((_, index) => !used.has(index + 1))) {
    throw new RangeError(`template expects ${used.size} parameters, got ${params.length}`);
  }
  return body.replace(PLACEHOLDER, (_, number: string) => params[Number(number) - 1] ?? "");
}

/** "a", "a y b", "a, b y c" (or "and"): the list of a template parameter or a subject. */
export function joinList(items: readonly string[], conjunction: string): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** First letter in upper case, for a label that opens a line. */
export function capitalize(text: string): string {
  const [first = "", ...rest] = [...text];
  return `${first.toUpperCase()}${rest.join("")}`;
}

/** Cuts at `max` characters with an ellipsis; WhatsApp rejects a list row description over 72. */
export function fitChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
