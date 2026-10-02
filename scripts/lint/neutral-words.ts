// The closed list of words that no visible surface of the product may contain (ADR-0014 §2) and the
// one matcher every check uses (ADR-0014 §3): `npm run lint:neutral-surfaces` over the visible
// sources, the web build and the whole tree, and scripts/landing/frame-check.ts over the text of every
// captured frame. This file is the only source of the list: a test that needs one of these words
// imports it from here and never writes it literally. Unlike FORBIDDEN_TERMS the list is public and
// needs no secret, so the checks print the word they found.
//
// Matching (ADR-0014 §3): NFKD without diacritics, camelCase and digit boundaries split, lowercase,
// tokens by [^a-z0-9]+; a word matches a whole token and a phrase matches consecutive tokens. So an
// identifier like `isJudgeClaim` or `JUDGE_TEST` matches, and "judgement" or "premium" never do.

export interface NeutralGroup {
  /** What `--group` takes on the command line, so the argument is never itself a listed word. */
  readonly group: number;
  /** Already normalized; a term with a space is a phrase of consecutive tokens. */
  readonly terms: readonly string[];
}

/** ADR-0014 §2, row by row. */
export const NEUTRAL_GROUPS: readonly NeutralGroup[] = [
  { group: 1, terms: ["hackathon", "hackathons", "hackaton", "hackatones", "devpost", "concurso", "concursos", "contest", "contests"] },
  { group: 2, terms: ["premio", "premios", "prize", "prizes"] },
  { group: 3, terms: ["jurado", "jurados", "jurada", "juradas", "juez", "jueces", "jury", "juries", "judge", "judges", "judged", "judging"] },
  {
    group: 4,
    terms: ["evaluacion", "evaluaciones", "evaluation", "evaluations", "evaluador", "evaluadores", "evaluadora", "evaluadoras", "evaluator", "evaluators"],
  },
  { group: 5, terms: ["aws cds"] },
];

/** The single-token words of the list (groups 1 to 4). */
export const NEUTRAL_WORDS: readonly string[] = NEUTRAL_GROUPS.flatMap((entry) => entry.terms.filter((term) => !term.includes(" ")));

/** The one phrase of the list (group 5). */
export const NEUTRAL_PHRASE = "aws cds";

export const NEUTRAL_GROUP_NUMBERS: readonly number[] = NEUTRAL_GROUPS.map((entry) => entry.group);

export interface NeutralHit {
  /** 1-based line of the text. */
  readonly line: number;
  /** The listed term, normalized (`aws cds` for the phrase). */
  readonly word: string;
  readonly group: number;
}

/** The tokens of one line after the normalization of ADR-0014 §3. */
export function neutralTokens(line: string): string[] {
  return line
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");
}

interface Term {
  readonly word: string;
  readonly group: number;
  readonly tokens: readonly string[];
}

const ALL_TERMS: readonly Term[] = NEUTRAL_GROUPS.flatMap((entry) => entry.terms.map((word) => ({ word, group: entry.group, tokens: word.split(" ") })));

function termsByFirstToken(groups: readonly number[] | undefined): Map<string, Term[]> {
  const index = new Map<string, Term[]>();
  for (const term of ALL_TERMS) {
    if (groups !== undefined && !groups.includes(term.group)) continue;
    const first = term.tokens[0] ?? "";
    index.set(first, [...(index.get(first) ?? []), term]);
  }
  return index;
}

const EVERY_GROUP = termsByFirstToken(undefined);

/**
 * Every listed term found in `text`, at most once per line and term, in line order. `groups` limits
 * the search to some rows of ADR-0014 §2 (the `--all-tree --group <n>` mode).
 */
export function findNeutralHits(text: string, groups?: readonly number[]): NeutralHit[] {
  const index = groups === undefined ? EVERY_GROUP : termsByFirstToken(groups);
  const hits: NeutralHit[] = [];
  text.split("\n").forEach((line, lineIndex) => {
    const tokens = neutralTokens(line);
    const seen = new Set<string>();
    tokens.forEach((token, start) => {
      for (const term of index.get(token) ?? []) {
        if (seen.has(term.word)) continue;
        if (term.tokens.every((part, offset) => tokens[start + offset] === part)) {
          seen.add(term.word);
          hits.push({ line: lineIndex + 1, word: term.word, group: term.group });
        }
      }
    });
  });
  return hits;
}
