// Oracles of the flows that depend on the model (docs/test-plan.md §4.3): the patterns no outbound
// message may carry, whatever the agent wrote, and the deterministic language check. The only URL an
// outbound message may carry is the importer's upload link; tariff positions, percentages, amounts in
// USD, full addresses and phone numbers never go out.
import { isInLanguage } from "@legajo/bff/services/language";

export const FORBIDDEN_PATTERNS = {
  /** NCM/HS tariff position (`8471.30`, `8471.30.12`). */
  TARIFF_POSITION: /\b\d{4}\.\d{2}(?:\.\d{2})?\b/,
  PERCENTAGE: /\d+(?:[.,]\d+)?\s?%/,
  USD_AMOUNT: /(?:\bUSD\s?\d|U\$S\s?\d|US\$\s?\d|\$\s?\d)/i,
  EMAIL: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  PHONE: /\+\d[\d\s-]{7,}\d/,
  URL: /\bhttps?:\/\/[^\s)]+/i,
} as const;

export type ForbiddenPattern = keyof typeof FORBIDDEN_PATTERNS;

/** Prefix of the only link an outbound message may carry. */
export const UPLOAD_LINK_PREFIX = "https://legajo.demo.craftech.io/u/";

/** Forbidden patterns found in an outbound text (the upload link is allowed; a masked address is not a full one). */
export function forbiddenIn(text: string, allowed: readonly ForbiddenPattern[] = []): ForbiddenPattern[] {
  const withoutLinks = text.replaceAll(/https:\/\/legajo\.demo\.craftech\.io\/u\/[A-Za-z0-9_-]+/g, "");
  return (Object.keys(FORBIDDEN_PATTERNS) as ForbiddenPattern[]).filter((name) => !allowed.includes(name) && FORBIDDEN_PATTERNS[name].test(withoutLinks));
}

/** A CUIT/CUIL or a CBU/CVU written in full: FL-050 wants none in conversations, Memory or logs. */
export const FULL_SENSITIVE = {
  CUIT: /\b\d{2}-?\d{8}-?\d\b/,
  CBU: /\b\d{22}\b/,
} as const;

export function fullSensitiveIn(text: string): Array<keyof typeof FULL_SENSITIVE> {
  return (Object.keys(FULL_SENSITIVE) as Array<keyof typeof FULL_SENSITIVE>).filter((name) => FULL_SENSITIVE[name].test(text));
}

/** Deterministic language check of a message (the word lists the outbound verification uses). */
export const isLanguage = (text: string, language: "es" | "en"): boolean => isInLanguage(text, language);
