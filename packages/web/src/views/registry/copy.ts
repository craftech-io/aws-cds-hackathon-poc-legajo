// Texts of the registry (`/app/registry`, docs/design-brief.md §6; FL-001, FL-003, FL-004, FL-006,
// FL-088) in Spanish (copy-es.ts) and English (copy-en.ts), with the same shape; the console's language
// picks one at render time (copy/localized.ts).
import type { ConsentMedium, DocType, SupplierBehaviour, SupplierContactStatus } from "@legajo/shared";
import { localized } from "../../copy/localized";
import { behaviourEn, contactStatusEn, docTypeEn, en, languageEn, mediumEn } from "./copy-en";
import { type RegistryCopy, behaviourEs, contactStatusEs, docTypeEs, es, languageEs, mediumEs } from "./copy-es";

export type { RegistryCopy } from "./copy-es";

export const registryCopy: RegistryCopy = localized({ es, en });

export const MEDIUM_LABELS: Readonly<Record<ConsentMedium, string>> = localized({ es: mediumEs, en: mediumEn });

export const CONTACT_STATUS_LABELS: Readonly<Record<SupplierContactStatus, string>> = localized({ es: contactStatusEs, en: contactStatusEn });

export const BEHAVIOUR_LABELS: Readonly<Record<SupplierBehaviour, string>> = localized({ es: behaviourEs, en: behaviourEn });

export const DOC_TYPE_LABELS: Readonly<Record<DocType, string>> = localized({ es: docTypeEs, en: docTypeEn });

export const LANGUAGE_LABELS: Readonly<Record<"es" | "en", string>> = localized({ es: languageEs, en: languageEn });

/** Version of the opt-in text the console registers (the text itself lives in the BFF's copy). */
export const CONSENT_TEXT_VERSIONS = ["v1"] as const;
