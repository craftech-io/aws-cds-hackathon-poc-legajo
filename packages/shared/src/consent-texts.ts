// The two check boxes of the sign-up form (ADR-0015 §2, docs/landing-spec.md §8.2), the single
// source of their words in Spanish and English: `terms` (terms and privacy policy, required to
// create the account) and `contact` (Craftech may get in touch about this solution, optional). Both
// start unticked. The form renders the runs below in order, a run with `link` as a link to that
// legal page in the same language. A lead stores the version each one was accepted with:
// `LEGAL_VERSIONS.terms` (plus `privacyVersion`) and `LEGAL_VERSIONS.contact`. Changing a word here
// without moving that version fails legal-versions.test.ts.
import type { Language } from "./enums";
import { LEGAL_PAGE_PATHS, type LegalPage } from "./legal-versions";

export const CONSENT_KINDS = ["terms", "contact"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** A run of a consent text: plain words, or words that link to one of the legal pages. */
export interface ConsentRun {
  readonly text: string;
  readonly link?: LegalPage;
}

export type ConsentText = readonly ConsentRun[];

export const SIGNUP_CONSENT_TEXTS: Readonly<Record<ConsentKind, Readonly<Record<Language, ConsentText>>>> = {
  terms: {
    es: [{ text: "Acepto los " }, { text: "términos", link: "terms" }, { text: " y la " }, { text: "política de privacidad", link: "privacy" }, { text: "." }],
    en: [{ text: "I accept the " }, { text: "terms", link: "terms" }, { text: " and the " }, { text: "privacy policy", link: "privacy" }, { text: "." }],
  },
  contact: {
    es: [{ text: "Acepto que Craftech me contacte por esta solución." }],
    en: [{ text: "I agree that Craftech may contact me about this solution." }],
  },
};

/** Whether the box must be ticked to create the account. */
export const CONSENT_REQUIRED: Readonly<Record<ConsentKind, boolean>> = { terms: true, contact: false };

/** The words of a consent as one string (labels, tests, the lead notice). */
export function consentPlainText(kind: ConsentKind, lang: Language): string {
  return SIGNUP_CONSENT_TEXTS[kind][lang].map((run) => run.text).join("");
}

/** Address of a legal page opened at the section of `lang` (`#es` / `#en`). */
export function legalPageHref(page: LegalPage, lang: Language): string {
  return `${LEGAL_PAGE_PATHS[page]}#${lang}`;
}
