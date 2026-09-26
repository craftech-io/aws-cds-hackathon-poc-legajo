// Memory sentinels of SC-09/11 and SC-20/5 (docs/tool-catalog.md `memory.inspect`, docs/test-plan.md
// §4.3 FL-050 and FL-087). Each is a set of keywords, not a phrase: a record matches when it holds one
// of them as a whole word (any case, any accent), so an extractor that paraphrases or translates still
// matches. A and B are dimensions of tone that no deadline, copy text or seed datum uses; F is a
// benign first-person fact of the importer, searched only among facts and only for the report.
// sentinels.test.ts keeps them apart from every other text the agent could see.

export interface Sentinel {
  /** What the importer writes in the scenario. */
  readonly phrase: string;
  readonly keywords: readonly string[];
}

export const SENTINELS = {
  /** Preference A: SC-09/11 and the first turn of SC-20/5. */
  A: { phrase: "preferiría mensajes sin emojis", keywords: ["emoji", "emojis", "emoticon", "emoticons", "emoticones"] },
  /** Preference B: the turn after the reset of SC-20/5; none of its records may match A. */
  B: { phrase: "tratame de usted, por favor", keywords: ["usted", "formal", "formally", "formalmente"] },
  /** Benign fact F of the importer itself (never a third party, which the exclusion instruction drops). */
  F: { phrase: "yo suelo subir los documentos por el link", keywords: ["link", "enlace"] },
} as const satisfies Record<string, Sentinel>;

/** Words that make a fact about someone else: a fact phrase names none of them. */
export const THIRD_PARTY_WORDS = ["proveedor", "exportador", "despachante", "estudio", "transportista", "supplier", "exporter", "broker", "carrier"] as const;

/** Markers of the first person in Spanish: a fact phrase carries at least one. */
export const FIRST_PERSON_WORDS = ["yo", "suelo", "mi", "mis", "me", "prefiero", "preferiría", "tratame"] as const;

/** The message of a sentinel turn: the preference together with the fact, so all three strategies have something to extract. */
export function sentinelMessage(preference: Sentinel, withSensitive?: string): string {
  return [withSensitive, `${preference.phrase}; ${SENTINELS.F.phrase}.`].filter((part) => part !== undefined).join(" ");
}
