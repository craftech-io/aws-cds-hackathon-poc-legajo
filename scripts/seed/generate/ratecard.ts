// Verified rate card (WP-41, docs/seed-spec.md §12 `RATECARD`, invariant 15): every row of
// `Reference/RATECARD` with its price, the official AWS source it was read from and the date it was
// read. Prices come from the AWS Price List (the machine-readable feed behind the official pricing
// pages) for us-east-1, read on RATE_CARD_AS_OF; each row keeps the price-list lines it adds up, so a
// reviewer can find them again by offer and usage type. `reference.ts` seeds these rows, and the
// estimates below (docs/test-plan.md §6, ADR-0015 §3.3 and §4) are priced with them through the same
// `dossierCost` the console uses.
//
//   tsx scripts/seed/generate/ratecard.ts                checks the committed seed and prints the estimates
//   tsx scripts/seed/generate/ratecard.ts --write        regenerates the seed (npm run seed:generate) first
//   tsx scripts/seed/generate/ratecard.ts --reserved 30  prices the guest worst case with 30 reserved accounts
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DossierUsage, type RateCardRow, type RateUnit, SES_OUTBOUND_RATE_KEY, type TokenKind, bedrockRateKey, dossierCost, whatsappRateKey } from "@legajo/bff/services/ratecard";
import { GUEST_QUOTAS, GUEST_SLOTS, PUBLIC_GLOBAL_BUDGET, RESERVED_GUESTS_DEFAULT } from "@legajo/shared/guest-limits";
import { EDGE_WAF_MONTHLY_COST_USD } from "../../../infra/edge-waf-spec";
import { PROJECT_BUDGET } from "../../../infra/observability-spec";
import { seedPaths } from "../lib/constants";
import { templateItem, type SeedItem } from "../lib/items";

/** Day the prices below were read from the AWS Price List. */
export const RATE_CARD_AS_OF = "2026-10-03";

const PRICE_LIST = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";
const offerUrl = (offer: string): string => `${PRICE_LIST}/${offer}/current/us-east-1/index.json`;

/** One line of the AWS Price List a rate adds up. */
export interface PriceListLine {
  readonly offer: string;
  readonly usageType: string;
  readonly description: string;
  readonly usd: number;
  /** `publicationDate` of the offer file that was read. */
  readonly publishedAt: string;
}

export interface VerifiedRate {
  readonly rateId: string;
  readonly unit: RateUnit;
  readonly source: string;
  readonly lines: readonly PriceListLine[];
}

const BEDROCK = "AmazonBedrockFoundationModels";
const BEDROCK_PUBLISHED = "2026-10-05";
const bedrockLine = (usageType: string, description: string, usd: number): PriceListLine => ({ offer: BEDROCK, usageType, description, usd, publishedAt: BEDROCK_PUBLISHED });

/** The Harness calls `global.anthropic.claude-haiku-4-5-20251001-v1:0`: the "Standard, Global" lines, 5-minute cache writes. */
const BEDROCK_LINES: readonly { readonly kind: TokenKind; readonly line: PriceListLine }[] = [
  { kind: "input", line: bedrockLine("USE1-MP:USE1_input_tokens_global_standard-Units", "Claude Haiku 4.5 · Input Tokens - Standard, Global", 1) },
  { kind: "output", line: bedrockLine("USE1-MP:USE1_output_tokens_global_standard-Units", "Claude Haiku 4.5 · Output Tokens - Standard, Global", 5) },
  { kind: "cacheRead", line: bedrockLine("USE1-MP:USE1_cache_read_tokens_global_standard-Units", "Claude Haiku 4.5 · Cache Read Tokens - Standard, Global", 0.1) },
  { kind: "cacheWrite", line: bedrockLine("USE1-MP:USE1_cache_write_tokens_global_standard-Units", "Claude Haiku 4.5 · Cache Write Tokens - Standard, Global", 1.25) },
];
const BEDROCK_RATES: readonly VerifiedRate[] = BEDROCK_LINES.map(({ kind, line }) => ({ rateId: bedrockRateKey(kind), unit: "PER_1M_TOKENS", source: offerUrl(BEDROCK), lines: [line] }));

/** Per recipient of `SendEmail`/`SendRawEmail` (US$ 0.0001), stored per thousand. Attachments (US$ 0.12 per GB) are not priced. */
const SES_RATE: VerifiedRate = {
  rateId: SES_OUTBOUND_RATE_KEY,
  unit: "PER_1K_MESSAGES",
  source: offerUrl("AmazonSES"),
  lines: [{ offer: "AmazonSES", usageType: "USE1-Recipients", description: "Outbound recipient (US$ 0.0001) × 1,000", usd: 0.1, publishedAt: "2026-09-11" }],
};

/**
 * An outbound WhatsApp message to Argentina: the AWS End User Messaging Social fee plus Meta's fee for
 * the template category, which AWS passes through. Service messages carry no Meta fee. Inbound
 * messages (US$ 0.001 each) are not part of the cost per dossier.
 */
const WHATSAPP_AWS_FEE: PriceListLine = { offer: "AmazonPinpoint", usageType: "USE1-WhatsApp-AR-MessageFee-Standard", description: "AWS fee per outbound WhatsApp message", usd: 0.005, publishedAt: "2026-09-15" };
const metaFee = (category: "Utility" | "Service", usd: number): PriceListLine => ({
  offer: "AWSEndUserMessaging3pFees",
  usageType: `USE1-WhatsApp-AR-ConversationFee-${category}`,
  description: `Meta fee, Argentina, ${category.toLowerCase()} template`,
  usd,
  publishedAt: "2026-09-16",
});
const WHATSAPP_SOURCE = "https://aws.amazon.com/end-user-messaging/pricing/";
const WHATSAPP_RATES: readonly VerifiedRate[] = [
  { rateId: whatsappRateKey("utility"), unit: "PER_MESSAGE", source: WHATSAPP_SOURCE, lines: [WHATSAPP_AWS_FEE, metaFee("Utility", 0.0206)] },
  { rateId: whatsappRateKey("service"), unit: "PER_MESSAGE", source: WHATSAPP_SOURCE, lines: [WHATSAPP_AWS_FEE, metaFee("Service", 0)] },
];

export const VERIFIED_RATES: readonly VerifiedRate[] = [...BEDROCK_RATES, SES_RATE, ...WHATSAPP_RATES];

// Prices are rounded to micro-dollars, like the costs `dossierCost` returns.
const micro = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

export function priceOf(rate: VerifiedRate): number {
  return micro(rate.lines.reduce((sum, line) => sum + line.usd, 0));
}

/** The `Reference/RATECARD` rows: verified, with price, source and date (invariant 15). */
export function rateCardItems(): SeedItem[] {
  return VERIFIED_RATES.map((rate) => templateItem("RateCard", { rateId: rate.rateId, price: priceOf(rate), unit: rate.unit, currency: "USD", source: rate.source, asOf: RATE_CARD_AS_OF, provisional: false }));
}

/** The same rows as `dossierCost` reads them. */
export function rateCardRows(): RateCardRow[] {
  return VERIFIED_RATES.map((rate) => ({ key: rate.rateId, price: priceOf(rate), unit: rate.unit, source: rate.source, asOf: RATE_CARD_AS_OF, provisional: false }));
}

// ---- Estimates (docs/test-plan.md §6, ADR-0015 §3.3 and §4) ---------------------------------------

/** Tokens of one agent turn assumed by docs/test-plan.md §6, priced uncached: a ceiling, not a forecast. */
export const TURN_ASSUMPTION = { inputTokens: { min: 30_000, max: 60_000 }, outputTokens: 1_000 } as const;
/** Happy path of a dossier: at most 8 turns (docs/test-plan.md §6). */
export const HAPPY_PATH_TURNS = 8;
/** "100 % probada": three full runs of up to 400 turns, plus the real-agent batch of 20 operations. */
export const GATE = { turnsPerSuite: 400, fullRuns: 3, batchOperations: 20 } as const;

export interface Range {
  readonly min: number;
  readonly max: number;
}

const NO_MESSAGES = { emails: 0, whatsapp: { utility: 0, service: 0 } } as const;

function usdOf(usage: DossierUsage): number {
  const cost = dossierCost(usage, rateCardRows(), { whatsappSimulated: true });
  if (cost.status !== "VERIFIED") throw new Error(`rate card is missing ${cost.missingRates.join(", ")}`);
  return cost.usd;
}

function turnsUsd(turns: number, emails = 0): Range {
  const at = (input: number): number =>
    usdOf({ tokens: { input: input * turns, output: TURN_ASSUMPTION.outputTokens * turns, cacheRead: 0, cacheWrite: 0 }, ...NO_MESSAGES, emails });
  return { min: at(TURN_ASSUMPTION.inputTokens.min), max: at(TURN_ASSUMPTION.inputTokens.max) };
}

const dailyLimit = (kind: "AGENT_TURNS" | "OUTBOUND_EMAILS"): number => {
  const day = GUEST_QUOTAS[kind].find((limit) => limit.window === "DAY");
  if (day === undefined) throw new Error(`${kind} has no daily quota`);
  return day.limit;
};

export interface CostEstimate {
  readonly perTurnUsd: Range;
  readonly happyPathDossierUsd: Range;
  readonly gate: { readonly turns: number; readonly usd: Range; readonly perExtraSuiteUsd: Range };
  readonly guestWorstDay: { readonly reserved: number; readonly turns: number; readonly emails: number; readonly usd: Range };
  readonly wafMonthlyUsd: Range;
  readonly projectBudgetUsdPerMonth: number;
}

/** Everything WP-41 prices with the verified card; `reserved` is the NN of `guest-01..NN`. */
export function estimateCosts(reserved: number = RESERVED_GUESTS_DEFAULT): CostEstimate {
  if (!Number.isInteger(reserved) || reserved < 0 || reserved > GUEST_SLOTS.reserved.last) throw new RangeError(`reserved accounts are 0 to ${GUEST_SLOTS.reserved.last}`);
  const gateTurns = GATE.turnsPerSuite * GATE.fullRuns + GATE.batchOperations * HAPPY_PATH_TURNS;
  const turns = (PUBLIC_GLOBAL_BUDGET.AGENT_TURNS ?? 0) + dailyLimit("AGENT_TURNS") * reserved;
  const emails = (PUBLIC_GLOBAL_BUDGET.OUTBOUND_EMAILS ?? 0) + dailyLimit("OUTBOUND_EMAILS") * reserved;
  return {
    perTurnUsd: turnsUsd(1),
    happyPathDossierUsd: turnsUsd(HAPPY_PATH_TURNS),
    gate: { turns: gateTurns, usd: turnsUsd(gateTurns), perExtraSuiteUsd: turnsUsd(GATE.turnsPerSuite) },
    guestWorstDay: { reserved, turns, emails, usd: turnsUsd(turns, emails) },
    wafMonthlyUsd: { ...EDGE_WAF_MONTHLY_COST_USD },
    projectBudgetUsdPerMonth: PROJECT_BUDGET.limitUsdPerMonth,
  };
}

// ---- CLI ------------------------------------------------------------------------------------------

const RATE_FIELDS = ["price", "unit", "currency", "source", "asOf", "provisional"] as const;

/** Rows of the committed `Reference.json` that differ from the verified card (empty when in step). */
export function rateCardDrift(referenceItems: readonly SeedItem[]): string[] {
  const committed = new Map(referenceItems.filter((item) => item.entity === "RateCard").map((item) => [String(item.rateId), item] as const));
  const expected = rateCardItems();
  const problems = expected.flatMap((row) => {
    const found = committed.get(String(row.rateId));
    if (found === undefined) return [`RATECARD ${String(row.rateId)} is missing`];
    return RATE_FIELDS.filter((field) => found[field] !== row[field]).map((field) => `RATECARD ${String(row.rateId)} ${field} differs from the verified card`);
  });
  const extra = [...committed.keys()].filter((rateId) => !expected.some((row) => row.rateId === rateId)).map((rateId) => `RATECARD ${rateId} is not in the verified card`);
  return [...problems, ...extra];
}

const usd = (value: number): string => `US$ ${value.toFixed(2)}`;
const range = (value: Range): string => `${usd(value.min)} – ${usd(value.max)}`;

function report(estimate: CostEstimate, dossierBudgets: readonly number[]): string[] {
  const { gate, guestWorstDay: guest } = estimate;
  return [
    `rate card verified on ${RATE_CARD_AS_OF} (AWS Price List, us-east-1):`,
    ...VERIFIED_RATES.map((rate) => `  ${rate.rateId.padEnd(46)} ${String(priceOf(rate)).padStart(8)} USD ${rate.unit}`),
    `per turn (${TURN_ASSUMPTION.inputTokens.min}–${TURN_ASSUMPTION.inputTokens.max} input + ${TURN_ASSUMPTION.outputTokens} output tokens, uncached): ${range(estimate.perTurnUsd)}`,
    `happy-path dossier (${HAPPY_PATH_TURNS} turns): ${range(estimate.happyPathDossierUsd)} against the seeded costBudgetUsdPerDossier ${dossierBudgets.map(usd).join(", ")}`,
    `"100 % probada" gate (${gate.turns} turns): ${range(gate.usd)}; each rerun of a full suite ${range(gate.perExtraSuiteUsd)}`,
    `guest worlds, worst day (${guest.turns} turns, ${guest.emails} emails, ${guest.reserved} reserved): ${range(guest.usd)}`,
    `WAF, fixed per month: ${range(estimate.wafMonthlyUsd)}; project budget ${usd(estimate.projectBudgetUsdPerMonth)} per month`,
  ];
}

function seedTable(table: "Firms" | "Reference"): SeedItem[] {
  return (JSON.parse(readFileSync(join(seedPaths().data, `${table}.json`), "utf8")) as { items: SeedItem[] }).items;
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--write")) {
    // Imported here: generate.ts reaches reference.ts, which imports this module.
    const { generate } = await import("../generate");
    const result = await generate();
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`  ${error}`);
      throw new Error(`seed:generate: ${result.errors.length} invariant(s) failed`);
    }
  }
  const reserved = Number(argValue(argv, "--reserved") ?? RESERVED_GUESTS_DEFAULT);
  const budgets = [...new Set(seedTable("Firms").filter((item) => item.entity === "FirmSettings").map((item) => Number(item.costBudgetUsdPerDossier)))].sort((a, b) => a - b);
  for (const line of report(estimateCosts(reserved), budgets)) console.log(line);
  const drift = rateCardDrift(seedTable("Reference"));
  if (drift.length > 0) {
    for (const problem of drift) console.error(`  ${problem}`);
    console.error("ratecard: the committed seed does not carry the verified rate card (reference.ts takes its rows from rateCardItems(); run with --write).");
    process.exit(1);
  }
  console.log("ratecard: the committed seed carries the verified rate card.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Not awaited at the top level: `--write` imports generate.ts, which reaches this module again
  // through reference.ts, and a pending top-level await would deadlock that cycle.
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
