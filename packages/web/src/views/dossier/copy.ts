// Texts of the dossier view in the console's language: the Spanish deck (copy-es.ts) fixes the shape,
// the English one (copy-en.ts) matches it, and each text resolves to the active language when it is
// read (copy/localized.ts).
import { localized } from "../../copy/localized";
import { en } from "./copy-en";
import { type DossierCopy, es } from "./copy-es";

export type { DossierCopy } from "./copy-es";

export const dossierCopy: DossierCopy = localized({ es, en });
