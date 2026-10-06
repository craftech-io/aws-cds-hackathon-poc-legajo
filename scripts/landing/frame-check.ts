// What a picture of the landing may never show (ADR-0016 §4, docs/test-plan.md §7): a term of the
// operator's external forbidden list, a word of the neutral list (ADR-0014 §2), a JSON web token, an
// AWS key, an upload link with its token, or an email address outside the demo's own domains (the
// simulated mailboxes of sim.legajo.demo.craftech.io and the app's legajo.demo.craftech.io). The
// capture and render scripts check the frame's text before they write it, and fail without writing
// it. Like `lint:forbidden`, a problem names the kind of leak and the line, never the matched text or
// term; a neutral word is public, so it is named.
import { type ForbiddenTerm, findTerms, listFromEnv } from "../lint/forbidden-terms";
import { findNeutralHits } from "../lint/neutral-words";

const LEAKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a JSON web token", /\beyJ[\w-]{8,}\.[\w-]{8,}/],
  ["an AWS access key id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["an upload link with its token", /\/u\/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
];

/** Domains a frame may show addresses of: the simulated mailboxes and the app's own. */
export const DEMO_EMAIL_DOMAINS = ["sim.legajo.demo.craftech.io", "legajo.demo.craftech.io"] as const;
const EMAIL = /[\w.+*%-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

function foreignEmail(line: string, allowed: readonly string[]): boolean {
  return [...line.matchAll(EMAIL)].some((match) => !(DEMO_EMAIL_DOMAINS as readonly string[]).includes((match[1] ?? "").toLowerCase()) && !allowed.includes(match[0].toLowerCase()));
}

/**
 * Problems of a frame's text: leaks by kind and line, forbidden terms by their position in the list, neutral words by name.
 * `allowedEmails` are exact addresses a page must show, such as the privacy mailbox of the data controller.
 */
export function frameProblems(text: string, terms: readonly ForbiddenTerm[], allowedEmails: readonly string[] = []): string[] {
  const problems: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const [what, pattern] of LEAKS) if (pattern.test(line)) problems.push(`${what} on line ${index + 1}`);
    if (foreignEmail(line, allowedEmails)) problems.push(`an email address outside the demo's domains on line ${index + 1}`);
  });
  for (const finding of findTerms("frame", text, terms)) problems.push(`term #${finding.term} of the forbidden list on line ${finding.line}`);
  for (const hit of findNeutralHits(text)) problems.push(`the neutral word "${hit.word}" on line ${hit.line}`);
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
