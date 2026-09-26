// Invariant 11 of docs/seed-spec.md §15: no text of any table, template or PDF (text and metadata)
// carries a term of the external forbidden list (`FORBIDDEN_TERMS`, the same matcher as
// `lint:forbidden`; with `CI=true` an absent list fails) nor a real company name of the generator's
// control list; and every company, vessel, carrier and institution name of the seed has its row in
// `Reference/NAMECHECK`. Findings never print a term: only where it was found.
import { findTerms, listFromEnv } from "../../lint/forbidden-terms";
import { ISSUING_BODY } from "../generate/documents";
import { pdfInfo, pdfTextLines } from "../lib/pdf";
import { realNamesIn } from "../lib/real-names";
import { str, type WorldView } from "./world-view";

export interface TextSource {
  readonly source: string;
  readonly text: string;
}

/** Every text of the seed: each data file as written, and each PDF's printed text and metadata. */
export function seedTexts(dataFiles: ReadonlyMap<string, Buffer>, pdfs: ReadonlyMap<string, Uint8Array>): TextSource[] {
  return [
    ...[...dataFiles].map(([path, bytes]) => ({ source: `scripts/seed/data/${path}`, text: bytes.toString("utf8") })),
    ...[...pdfs].map(([path, bytes]) => ({ source: `scripts/seed/pdfs/${path}`, text: [...pdfTextLines(bytes), ...Object.values(pdfInfo(bytes))].join("\n") })),
  ];
}

export function controlListProblems(texts: readonly TextSource[]): string[] {
  return texts.flatMap(({ source, text }) => (realNamesIn(text).length > 0 ? [`${source} names a real company of the generator's control list`] : []));
}

export interface ForbiddenCheck {
  readonly errors: string[];
  readonly warnings: string[];
}

/** The external list over every text; without the list it warns locally and fails with `CI=true`. */
export function forbiddenTermProblems(texts: readonly TextSource[], env: NodeJS.ProcessEnv = process.env): ForbiddenCheck {
  const list = listFromEnv(env);
  if (!list.ok) return list.fatal ? { errors: [`forbidden terms: ${list.message}`], warnings: [] } : { errors: [], warnings: [`forbidden terms not checked: ${list.message}`] };
  const errors = texts.flatMap(({ source, text }) => findTerms(source, text, list.terms).map((finding) => `${finding.source}:${finding.line} has term #${finding.term} of the forbidden list`));
  return { errors, warnings: [] };
}

/** Names that must have a NAMECHECK row: firms, importers, suppliers, vessels, carriers, the issuing body. */
export function seedNames(views: readonly WorldView[]): Set<string> {
  const names = new Set<string>([ISSUING_BODY]);
  for (const view of views) {
    for (const firm of view.of("Firm")) names.add(str(firm.name));
    for (const importer of view.of("Importer")) names.add(str(importer.name));
    for (const supplier of view.of("Supplier")) names.add(str(supplier.name));
    for (const operation of view.of("Operation")) {
      names.add(str(operation.vessel));
      names.add(str(operation.carrier));
    }
  }
  names.delete("");
  return names;
}

export function nameCheckProblems(names: ReadonlySet<string>, reference: WorldView): string[] {
  const checked = new Map(reference.of("NameCheck").map((row) => [str(row.name), row]));
  const problems: string[] = [];
  for (const name of names) {
    const row = checked.get(name);
    if (row === undefined) problems.push(`"${name}" has no NAMECHECK row`);
    else if (str(row.query) === "" || str(row.checkedAt) === "" || str(row.result) === "") problems.push(`the NAMECHECK row of "${name}" lacks its query, date or result`);
  }
  return problems;
}
