// What a picture of the landing may never show (docs/design-brief.md §9, docs/test-plan.md §7): a
// term of the operator's external forbidden list, a token or a key. The capture and render scripts
// check the whole page's text before they write a frame, and fail without writing it. Like
// `lint:forbidden`, a problem names the kind of leak and the line, never the matched text or term.
import { type ForbiddenTerm, findTerms, listFromEnv } from "../lint/forbidden-terms";

const LEAKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a JSON web token", /\beyJ[\w-]{8,}\.[\w-]{8,}/],
  ["an AWS access key id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["an upload link with its token", /\/u\/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
];

/** Problems of a frame's text: leaks by kind and line, forbidden terms by their position in the list. */
export function frameProblems(text: string, terms: readonly ForbiddenTerm[]): string[] {
  const problems: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const [what, pattern] of LEAKS) if (pattern.test(line)) problems.push(`${what} on line ${index + 1}`);
  });
  for (const finding of findTerms("frame", text, terms)) problems.push(`term #${finding.term} of the forbidden list on line ${finding.line}`);
  return problems;
}

/** Throws when the frame of `id` has a problem; the message carries no matched text. */
export function assertCleanFrame(id: string, text: string, terms: readonly ForbiddenTerm[]): void {
  const problems = frameProblems(text, terms);
  if (problems.length > 0) throw new Error(`${id}: the frame shows ${problems.join("; ")}`);
}

/**
 * The forbidden list for a picture that becomes public. `required` (console captures, which show
 * the seed and what the model wrote) fails closed without it; renders of our own page copy follow
 * `lint:forbidden` instead: fatal in CI, a warning on a laptop.
 */
export function termsFor(required: boolean, env: NodeJS.ProcessEnv = process.env): ForbiddenTerm[] {
  const list = listFromEnv(env);
  if (list.ok) return list.terms;
  if (required || list.fatal) throw new Error(`FORBIDDEN_TERMS is absent or empty: no picture is written without the list (${list.message})`);
  process.stderr.write(`landing: ${list.message}\n`);
  return [];
}
