// Versions of the texts a visitor accepts when creating an account (ADR-0015 §2 and §8,
// docs/landing-spec.md §8.2 and §8.9): the terms page, the privacy policy and the optional consent
// to be contacted by Craftech. Each one is the date (`YYYY-MM-DD`) its current text took effect.
// A lead stores, per consent, the version it was given with (`terms` also keeps `privacyVersion`),
// and `signup.start` rejects a form whose `consentVersions` are not these (a tab opened before a
// change, FL-119). Changing a text without moving its version here fails legal-versions.test.ts.
import { z } from "zod";
import { CalendarDate } from "./dates";

export const LegalDocument = z.enum(["terms", "privacy", "contact"]);
export type LegalDocument = z.infer<typeof LegalDocument>;

export const LegalVersions = z
  .object({
    terms: CalendarDate,
    privacy: CalendarDate,
    contact: CalendarDate,
  })
  .strict();
export type LegalVersions = z.infer<typeof LegalVersions>;

export const LEGAL_VERSIONS: LegalVersions = Object.freeze({
  terms: "2026-10-02",
  privacy: "2026-10-04",
  contact: "2026-10-02",
});

/** The two static pages, served by the console bucket (infra/web-spec.ts `LEGAL_PAGES`). */
export const LEGAL_PAGE_PATHS = Object.freeze({
  terms: "/legal/terms.html",
  privacy: "/legal/privacy.html",
} as const);
export type LegalPage = keyof typeof LEGAL_PAGE_PATHS;

/** True when a form was filled in with the texts in force (every version equal to `LEGAL_VERSIONS`). */
export function isCurrentLegalVersions(value: unknown): value is LegalVersions {
  const parsed = LegalVersions.safeParse(value);
  return parsed.success && LegalDocument.options.every((document) => parsed.data[document] === LEGAL_VERSIONS[document]);
}
