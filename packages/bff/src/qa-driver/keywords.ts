// Keyword matching of the Memory sentinels (docs/tool-catalog.md `memory.inspect`): a record matches
// when it contains one of the keywords as a whole word, ignoring case and accents, so an extractor that
// paraphrases or translates ("prefers messages without emojis") still matches. The driver receives
// the words and knows nothing of the scenarios; scripts/scenarios/lib/sentinels.ts declares them.

/** Lower case without diacritics: "Emoticón" and "emoticon" fold to the same word. */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** The words of a text, folded: runs of letters and digits. */
export function wordsOf(text: string): string[] {
  return foldText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** True when one of `keywords` is a whole word of `text`. */
export function matchesKeywords(text: string, keywords: readonly string[]): boolean {
  const words = new Set(wordsOf(text));
  return keywords.some((keyword) => words.has(foldText(keyword)));
}
