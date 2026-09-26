// The generator's control list of real company names (docs/seed-spec.md §15, invariant 11): names the
// registered searches of `Reference/NAMECHECK` found as real companies close to a fictitious name of
// the seed. The repository must not name them, so the list holds only the SHA-256 of each name
// normalized by `normalizeName`; the validator hashes every run of one to four words of the seed's
// texts and PDFs and fails on a match.
import { createHash } from "node:crypto";

/** Lower case, no accents, words of letters and digits separated by one space. */
export function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** SHA-256 of the normalized real names (never the names themselves). */
export const REAL_NAME_HASHES: ReadonlySet<string> = new Set([
  "accdae803afb505bba2dffbf3a1afbacead644d1eacad7b8de4753f9eb6b665c",
  "e0fbf1e9c7d27b12e5f932dc503b2d3562379b069cee1557bf7c0dc82f9ee28d",
  "4436d2c6c7ef606f5c5043fdac97b1cd7cd6962fe007e65beb95bec22ca30fdc",
  "1cf47c0400adcb8135c5e298455efb8b61e485512906926a6cf83bd1b649d2f0",
  "2efc168260a791385db64238e1f50a90342cc484e13d798aab7ab8330b86d644",
  "d6eabf6bde154e59ddd2b7e159d681210d1ad8f9d0cd2156a4ca8204a7af6c49",
]);

export const MAX_NAME_WORDS = 4;

/** Real names of the control list found in `text`, as their hashes. */
export function realNamesIn(text: string): string[] {
  const words = normalizeName(text).split(" ").filter((word) => word !== "");
  const found = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    for (let length = 1; length <= MAX_NAME_WORDS && start + length <= words.length; length += 1) {
      const hash = createHash("sha256").update(words.slice(start, start + length).join(" ")).digest("hex");
      if (REAL_NAME_HASHES.has(hash)) found.add(hash);
    }
  }
  return [...found];
}
