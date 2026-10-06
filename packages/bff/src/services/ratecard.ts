// Cost per dossier (docs/design-brief.md §8, CONTEXT.md "Costo por legajo"): Bedrock tokens of the
// operation's turns plus messages sent, priced with the `RATECARD` rows of `Reference`
// (docs/seed-spec.md §12). A row carries its price, unit, official source and date; the seed ships
// them `provisional` with no price until WP-41 loads verified prices, and until then the metric
// says it has no verified rate instead of showing a number. WhatsApp in `simulated` mode is priced
// as if it were live, and the result says so.
import { z } from "zod";
import { CalendarDate } from "@legajo/shared";

/** Model of the Harness (docs/architecture.md §1); its token rows are keyed by this id. */
export const HARNESS_MODEL_ID = "global.anthropic.claude-sonnet-5-5";

export const TokenKind = z.enum(["input", "output", "cacheRead", "cacheWrite"]);
export type TokenKind = z.infer<typeof TokenKind>;

export const WhatsAppPricing = z.enum(["utility", "service"]);
export type WhatsAppPricing = z.infer<typeof WhatsAppPricing>;

export function bedrockRateKey(kind: TokenKind, modelId: string = HARNESS_MODEL_ID): string {
  // A model id may carry a version after ":" (`…-v1:0`); the key keeps one ":" per part.
  return `bedrock:${modelId.replace(/:/g, "-")}:${kind}`;
}

export const SES_OUTBOUND_RATE_KEY = "ses:outbound";

export function whatsappRateKey(pricing: WhatsAppPricing, country = "AR"): string {
  return `whatsapp:${country}:${pricing}`;
}

/** Price per million tokens, per thousand messages or per message, always in USD. */
export const RateUnit = z.enum(["PER_1M_TOKENS", "PER_1K_MESSAGES", "PER_MESSAGE"]);
export type RateUnit = z.infer<typeof RateUnit>;

const UNIT_SIZE: Readonly<Record<RateUnit, number>> = { PER_1M_TOKENS: 1_000_000, PER_1K_MESSAGES: 1_000, PER_MESSAGE: 1 };

export const RateCardRow = z
  .object({
    key: z.string().regex(/^[a-z]+:[A-Za-z0-9._-]+(?::[A-Za-z]+)?$/, "expected <service>:<scope>[:<kind>]"),
    price: z.number().nonnegative().nullable(),
    unit: RateUnit,
    /** Official pricing page the price was read from. */
    source: z.string().min(1).nullable(),
    asOf: CalendarDate.nullable(),
    provisional: z.boolean(),
  })
  .superRefine((row, ctx) => {
    // Seed invariant 15: a row that is not provisional has price, source and date.
    if (row.provisional) return;
    for (const field of ["price", "source", "asOf"] as const) {
      if (row[field] === null) ctx.addIssue({ code: "custom", path: [field], message: `a verified rate needs ${field}` });
    }
  });
export type RateCardRow = z.infer<typeof RateCardRow>;

const Count = z.number().int().nonnegative();

/** What an operation consumed: token usage of its turns (`metadata.usage`) and messages sent. */
export const DossierUsage = z
  .object({
    tokens: z.object({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count }).strict(),
    emails: Count,
    whatsapp: z.object({ utility: Count, service: Count }).strict(),
  })
  .strict();
export type DossierUsage = z.infer<typeof DossierUsage>;

export interface CostLine {
  readonly key: string;
  readonly quantity: number;
  readonly unit: RateUnit;
  readonly price: number;
  readonly usd: number;
}

export type DossierCost =
  | { readonly status: "VERIFIED"; readonly usd: number; readonly lines: readonly CostLine[]; readonly whatsappPricedAsLive: boolean }
  /** Some line has no verified rate: no total is shown ("sin tarifa verificada"). */
  | { readonly status: "UNVERIFIED"; readonly missingRates: readonly string[]; readonly whatsappPricedAsLive: boolean };

export interface CostOptions {
  /** WhatsApp ran `simulated`: messages are still priced as live ones, and labelled so. */
  readonly whatsappSimulated: boolean;
  readonly modelId?: string;
}

// Money in USD is rounded to micro-dollars: a turn costs cents, a dossier a few dollars.
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function quantities(usage: DossierUsage, modelId: string): ReadonlyArray<readonly [string, number]> {
  return [
    ...TokenKind.options.map((kind) => [bedrockRateKey(kind, modelId), usage.tokens[kind]] as const),
    [SES_OUTBOUND_RATE_KEY, usage.emails] as const,
    ...WhatsAppPricing.options.map((pricing) => [whatsappRateKey(pricing), usage.whatsapp[pricing]] as const),
  ];
}

/** Prices a dossier's usage. Only lines with a quantity need a rate; one without a verified rate makes the whole cost unverified. */
export function dossierCost(usage: DossierUsage, rows: readonly unknown[], options: CostOptions): DossierCost {
  const parsedUsage = DossierUsage.parse(usage);
  const rates = new Map(z.array(RateCardRow).parse(rows).map((row) => [row.key, row] as const));
  const whatsappPricedAsLive = options.whatsappSimulated && parsedUsage.whatsapp.utility + parsedUsage.whatsapp.service > 0;
  const lines: CostLine[] = [];
  const missingRates: string[] = [];
  for (const [key, quantity] of quantities(parsedUsage, options.modelId ?? HARNESS_MODEL_ID)) {
    if (quantity === 0) continue;
    const rate = rates.get(key);
    if (rate === undefined || rate.provisional || rate.price === null) {
      missingRates.push(key);
      continue;
    }
    lines.push({ key, quantity, unit: rate.unit, price: rate.price, usd: roundUsd((quantity / UNIT_SIZE[rate.unit]) * rate.price) });
  }
  if (missingRates.length > 0) return { status: "UNVERIFIED", missingRates, whatsappPricedAsLive };
  return { status: "VERIFIED", usd: roundUsd(lines.reduce((sum, line) => sum + line.usd, 0)), lines, whatsappPricedAsLive };
}

/** True while any row is provisional: the metrics view labels every cost "sin tarifa verificada". */
export function hasProvisionalRates(rows: readonly unknown[]): boolean {
  return z.array(RateCardRow).parse(rows).some((row) => row.provisional);
}
