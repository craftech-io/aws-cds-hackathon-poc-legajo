// Deterministic verification of every outbound text (docs/design-brief.md §5.5, docs/architecture.md
// §13 "Saliente"), what G2 does not guarantee:
//
//   FACTS     every date, time, weight, amount, operation number and document code of a text the
//             model wrote exists in the tool results of the turn (`Runtime/TURN#`)
//   PARAMS    every parameter of a template the model filled is one of those results ("Estudio Delta",
//             "22/10"), or a list of them ("packing list y certificado de origen")
//   REQUIRED  an email to the supplier carries the invoice number and, when the dossier has one, the
//             supplier's deadline exactly as `get_dossier` returned it
//   LANGUAGE  Spanish to the importer and the firm, English to the supplier (services/language.ts); a
//             text the code or a person wrote fails only when it is clearly in the other language
//
// The sensitive asks (`CP-NO-SENSITIVE-ASK`) and the foreign links (`CP-NO-FOREIGN-LINKS`, links.ts) are
// rules of the contact policy, decided with the verdicts the pipeline hands the engine. A failure here
// is `GROUNDING_FAIL`; its detail names facts and checks, never a party's data.
import { z } from "zod";
import type { Language, MessageKind } from "@legajo/shared";
import type { TurnResult } from "../domain/runtime";
import { detectLanguage } from "../services/language";
import { collectSourceFacts, normalizeLeaf, type SourceFacts, ungroundedFacts } from "./text-facts";
import type { TextSource } from "./types";

export type VerifyCheck = "FACTS" | "PARAMS" | "REQUIRED" | "LANGUAGE";

export interface VerifyFailure {
  readonly check: VerifyCheck;
  readonly detail: string;
}

export interface VerifyInput {
  /** Spanish for the importer and the firm, English for the supplier. */
  readonly language: Language;
  readonly textSource: TextSource;
  readonly text?: string;
  readonly templateParams?: readonly string[];
  /** Tool outputs of the turn (redacted, as `Runtime/TURN#` keeps them). */
  readonly sources: readonly unknown[];
  /** Strings the text has to contain (`requiredSupplierContent`). */
  readonly required?: readonly string[];
}

/** The outputs of the turn's results, the grounding of the verification and of G2. */
export function outputsOf(results: readonly Pick<TurnResult, "output">[]): unknown[] {
  return results.map((result) => result.output);
}

const LIST_SEPARATOR = /\s*(?:,|\by\b|\band\b)\s*/u;

/** A template parameter is grounded when it is a result, a list of results, or nothing but grounded facts. */
function paramGrounded(param: string, facts: SourceFacts): boolean {
  const leaf = normalizeLeaf(param);
  if (facts.leaves.has(leaf)) return true;
  const parts = leaf.split(LIST_SEPARATOR).filter((part) => part !== "");
  if (parts.length > 1 && parts.every((part) => facts.leaves.has(part))) return true;
  const onlyFacts = !/\p{L}{3,}/u.test(param.replace(/\b(?:de|del|y|and|kg|hs?|usd|ars|eur)\b/giu, ""));
  return onlyFacts && /\d/.test(param) && ungroundedFacts(param, "es", facts).length === 0;
}

function languageFailure(input: VerifyInput, text: string): VerifyFailure | undefined {
  const { language } = detectLanguage(text);
  if (language === input.language) return undefined;
  // A short fixed text or a person's message may be undecidable; only the model must prove its language.
  if (input.textSource !== "MODEL" && language === "und") return undefined;
  return { check: "LANGUAGE", detail: `the text must be in ${input.language === "es" ? "Spanish" : "English"} (detected ${language})` };
}

function contains(text: string, needle: string): boolean {
  return normalizeLeaf(text).includes(normalizeLeaf(needle));
}

/** Every failed check of an outbound text; empty when it may go out. */
export function verifyContent(input: VerifyInput): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  const facts = collectSourceFacts(input.sources);
  const { text } = input;
  if (text !== undefined) {
    const language = languageFailure(input, text);
    if (language !== undefined) failures.push(language);
    if (input.textSource === "MODEL") {
      const ungrounded = ungroundedFacts(text, input.language, facts);
      if (ungrounded.length > 0) failures.push({ check: "FACTS", detail: `not in this turn's tool results: ${ungrounded.slice(0, 5).join(", ")}` });
      const missing = (input.required ?? []).filter((needle) => !contains(text, needle));
      if (missing.length > 0) failures.push({ check: "REQUIRED", detail: `the text must carry ${missing.length === 1 ? "this value" : "these values"} exactly as the tools returned them: ${missing.join(" | ")}` });
    }
  }
  if (input.textSource === "MODEL" && input.templateParams !== undefined) {
    const loose = input.templateParams.map((param, index) => (paramGrounded(param, facts) ? undefined : index + 1)).filter((index) => index !== undefined);
    if (loose.length > 0) failures.push({ check: "PARAMS", detail: `template parameter ${loose.join(", ")} is not a value of this turn's tool results` });
  }
  return failures;
}

const DossierDeadline = z.object({ deadlines: z.object({ supplier: z.object({ text: z.string().min(1) }).optional() }).optional() });

/** Kinds that ask the supplier for something by a deadline. */
const DEADLINE_KINDS: readonly MessageKind[] = ["DOCS_REQUEST", "REMINDER", "CORRECTION_REQUEST", "ETA_CHANGE"];

/**
 * What a model-written email to the supplier must carry (docs/tool-catalog.md `send_email`): the
 * invoice number and, for a request with a deadline, the supplier's deadline as `get_dossier`
 * returned it in this turn (its newest result).
 */
export function requiredSupplierContent(kind: MessageKind, invoiceNumber: string, results: readonly Pick<TurnResult, "tool" | "output">[]): string[] {
  const required = [invoiceNumber];
  if (!DEADLINE_KINDS.includes(kind)) return required;
  const dossier = results.filter((result) => result.tool === "get_dossier").at(-1);
  const deadline = DossierDeadline.safeParse(dossier?.output).data?.deadlines?.supplier?.text;
  return deadline === undefined ? required : [...required, deadline];
}
