// What the deterministic verification compares (docs/design-brief.md §5.5, outbound/verify.ts): the
// dates, times, weights, amounts, operation numbers and document codes of an outbound text, in
// Rioplatense Spanish ("18/10 17:00", "18 de octubre", "1.250 kg") or English ("October 18", "Oct 18,
// 17:00", "1,250 kg", "USD 12,500.00"), and the same facts read from the redacted tool results of the
// turn (`Runtime/TURN#`). Pure: no clock, no I/O, no `Intl`.
import type { Language } from "@legajo/shared";

export interface DayMonth {
  readonly day: number;
  readonly month: number;
  readonly year?: number;
}

export interface TextFacts {
  readonly dates: readonly DayMonth[];
  /** `HH:MM`. */
  readonly times: readonly string[];
  /** Amounts, weights and integers of three or more digits (operation numbers). */
  readonly numbers: readonly number[];
  /** Document codes in upper case (`QBT-2026-0917`). */
  readonly codes: readonly string[];
}

const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_NAMES = [...MONTHS_ES, "setiembre", ...MONTHS_EN, ...MONTHS_EN.map((name) => name.slice(0, 3)), "sept"].sort((a, b) => b.length - a.length).join("|");

const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?!\d)/g;
const SLASH_DATE = /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g;
const DAY_FIRST = new RegExp(`(?<!\\d)(\\d{1,2})(?:\\s+de)?\\s+(${MONTH_NAMES})\\.?(?:,?\\s+(?:de\\s+|del\\s+)?(\\d{4}))?(?![a-z])`, "giu");
const MONTH_FIRST = new RegExp(`(?<![a-z])(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!\\d)`, "giu");
const TIME = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?:\s?hs?\b)?(?![\d:])/g;
const CODE = /(?<![A-Za-z0-9-])(?=[A-Za-z0-9/-]*\d)(?=[A-Za-z0-9/-]*[A-Za-z])[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)+(?![A-Za-z0-9-])/g;
const NUMBER = "\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
const CURRENCY_AMOUNT = new RegExp(`(?:US\\$|U\\$S|USD|ARS|EUR|€|\\$)\\s?(${NUMBER})(?![\\d.,]*\\d)`, "giu");
const AMOUNT_CURRENCY = new RegExp(`(?<![\\d.,])(${NUMBER})\\s?(?:USD|ARS|EUR|dólares|dolares|dollars|pesos|euros)\\b`, "giu");
const WEIGHT = new RegExp(`(?<![\\d.,])(${NUMBER})\\s?(?:kg|kgs|kilos|kilogramos|kilograms|toneladas|tons?|t|lbs?)\\b`, "giu");
const BIG_INTEGER = /(?<![\d.,])\d{3,}(?![\d.,]*\d)/g;

function monthOf(name: string): number {
  const lowered = name.toLowerCase();
  if (lowered === "setiembre" || lowered === "sept") return 9;
  const es = MONTHS_ES.indexOf(lowered);
  if (es >= 0) return es + 1;
  return MONTHS_EN.findIndex((month) => month === lowered || month.slice(0, 3) === lowered) + 1;
}

function fullYear(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
}

function validDay(date: DayMonth): boolean {
  return date.month >= 1 && date.month <= 12 && date.day >= 1 && date.day <= 31;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A number as written: with both separators the last one is the decimal one; a single separator
 * followed by exactly three digits is a thousands separator in the language's convention (`.` in
 * Spanish, `,` in English). `both` returns every reading, for the sources, whose language is unknown.
 */
export function readNumber(raw: string, lang: Language | "both"): number[] {
  const hasDot = raw.includes(".");
  const hasComma = raw.includes(",");
  if (!hasDot && !hasComma) return [Number(raw)];
  if (hasDot && hasComma) {
    const decimal = raw.lastIndexOf(".") > raw.lastIndexOf(",") ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    return [Number(raw.split(thousands).join("").replace(decimal, "."))];
  }
  const separator = hasDot ? "." : ",";
  const parts = raw.split(separator);
  const asThousands = Number(parts.join(""));
  const asDecimal = parts.length === 2 ? Number(`${parts[0] ?? ""}.${parts[1] ?? ""}`) : Number.NaN;
  if (parts.length > 2 || (parts[1] ?? "").length !== 3) return [Number.isNaN(asDecimal) ? asThousands : asDecimal];
  if (lang === "both") return [asThousands, asDecimal];
  const thousandsSeparator = lang === "es" ? "." : ",";
  return [separator === thousandsSeparator ? asThousands : asDecimal];
}

type Groups = readonly (string | undefined)[];

/** Removes every match so a later pattern never reads it twice. */
function consume(text: string, pattern: RegExp, onMatch: (groups: Groups) => void): string {
  return text.replace(pattern, (...args: unknown[]) => {
    onMatch(args.slice(0, -2) as Groups);
    return " ";
  });
}

interface Collector {
  readonly dates: DayMonth[];
  readonly times: string[];
  readonly numbers: number[];
  readonly codes: string[];
}

function collect(input: string, lang: Language | "both", into: Collector): void {
  let text = input.normalize("NFC");
  const addDate = (date: DayMonth): void => {
    if (validDay(date)) into.dates.push(date);
  };
  const addTime = (hours: string | undefined, minutes: string | undefined): void => {
    if (hours !== undefined && minutes !== undefined) into.times.push(`${pad(Number(hours))}:${minutes}`);
  };
  const addNumbers = (raw: string | undefined): void => {
    if (raw !== undefined) into.numbers.push(...readNumber(raw, lang).filter((value) => Number.isFinite(value)));
  };
  text = consume(text, ISO_DATE, (m) => {
    addDate({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
    addTime(m[4], m[5]);
  });
  text = consume(text, DAY_FIRST, (m) => addDate({ day: Number(m[1]), month: monthOf(m[2] ?? ""), ...(m[3] === undefined ? {} : { year: Number(m[3]) }) }));
  text = consume(text, MONTH_FIRST, (m) => addDate({ day: Number(m[2]), month: monthOf(m[1] ?? ""), ...(m[3] === undefined ? {} : { year: Number(m[3]) }) }));
  text = consume(text, SLASH_DATE, (m) => {
    const year = fullYear(m[3]);
    const dayFirst = { day: Number(m[1]), month: Number(m[2]), ...(year === undefined ? {} : { year }) };
    // A US-style 10/18 that cannot be a day-first date is read month first.
    addDate(validDay(dayFirst) ? dayFirst : { day: Number(m[2]), month: Number(m[1]), ...(year === undefined ? {} : { year }) });
  });
  text = consume(text, TIME, (m) => addTime(m[1], m[2]));
  text = consume(text, CODE, (m) => {
    if (m[0] !== undefined) into.codes.push(m[0].toUpperCase());
  });
  text = consume(text, CURRENCY_AMOUNT, (m) => addNumbers(m[1]));
  text = consume(text, AMOUNT_CURRENCY, (m) => addNumbers(m[1]));
  text = consume(text, WEIGHT, (m) => addNumbers(m[1]));
  consume(text, BIG_INTEGER, (m) => addNumbers(m[0]));
}

/** The facts of an outbound text written in `lang`. */
export function extractTextFacts(text: string, lang: Language): TextFacts {
  const into: Collector = { dates: [], times: [], numbers: [], codes: [] };
  collect(text, lang, into);
  return into;
}

// ---- Facts of the sources -------------------------------------------------------------------------

export interface SourceFacts {
  /** `MM-DD` and `YYYY-MM-DD` of every date the sources name. */
  readonly dates: Set<string>;
  readonly times: Set<string>;
  readonly numbers: Set<number>;
  readonly codes: Set<string>;
  /** Every string value, normalized (`normalizeLeaf`): what a template parameter is compared with. */
  readonly leaves: Set<string>;
}

/** Lower case, accents kept, inner whitespace collapsed: "Estudio  Delta " → "estudio delta". */
export function normalizeLeaf(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addSourceString(value: string, facts: SourceFacts): void {
  facts.leaves.add(normalizeLeaf(value));
  const into: Collector = { dates: [], times: [], numbers: [], codes: [] };
  collect(value, "both", into);
  for (const date of into.dates) {
    facts.dates.add(`${pad(date.month)}-${pad(date.day)}`);
    if (date.year !== undefined) facts.dates.add(`${date.year}-${pad(date.month)}-${pad(date.day)}`);
  }
  for (const time of into.times) facts.times.add(time);
  for (const number of into.numbers) facts.numbers.add(round2(number));
  for (const code of into.codes) facts.codes.add(code);
  // A plain number in a string ("4471", "1250") is a fact too.
  if (/^-?\d+(?:\.\d+)?$/.test(value.trim())) facts.numbers.add(round2(Number(value)));
}

function walk(value: unknown, facts: SourceFacts, depth: number): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) facts.numbers.add(round2(value));
    return;
  }
  if (typeof value === "string") return addSourceString(value, facts);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, facts, depth + 1);
    return;
  }
  if (typeof value === "object") for (const item of Object.values(value)) walk(item, facts, depth + 1);
}

export function collectSourceFacts(sources: readonly unknown[]): SourceFacts {
  const facts: SourceFacts = { dates: new Set(), times: new Set(), numbers: new Set(), codes: new Set(), leaves: new Set() };
  for (const source of sources) walk(source, facts, 0);
  return facts;
}

/** A date without a year matches any source date of the same day and month. */
export function hasDate(facts: SourceFacts, date: DayMonth): boolean {
  const dayMonth = `${pad(date.month)}-${pad(date.day)}`;
  return date.year === undefined ? facts.dates.has(dayMonth) : facts.dates.has(`${date.year}-${dayMonth}`);
}

export function hasNumber(facts: SourceFacts, value: number): boolean {
  const target = round2(value);
  for (const known of facts.numbers) if (Math.abs(known - target) < 0.005) return true;
  return false;
}

/** The facts of `text` the sources do not name, as short labels (`date 25/10`, `number 1300`). */
export function ungroundedFacts(text: string, lang: Language, sources: SourceFacts): string[] {
  const found = extractTextFacts(text, lang);
  return [
    ...found.dates.filter((date) => !hasDate(sources, date)).map((date) => `date ${pad(date.day)}/${pad(date.month)}`),
    ...found.times.filter((time) => !sources.times.has(time)).map((time) => `time ${time}`),
    ...found.numbers.filter((number) => !hasNumber(sources, number)).map((number) => `number ${number}`),
    ...found.codes.filter((code) => !sources.codes.has(code)).map((code) => `code ${code}`),
  ];
}
