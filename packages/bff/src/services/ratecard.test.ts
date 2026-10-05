import { describe, expect, it } from "vitest";
import { type DossierUsage, type RateCardRow, SES_OUTBOUND_RATE_KEY, bedrockRateKey, dossierCost, hasProvisionalRates, whatsappRateKey } from "./ratecard";

// Test-only prices: the real rows are loaded from the official pages by WP-41.
const verified = (key: string, price: number, unit: RateCardRow["unit"]): RateCardRow => ({ key, price, unit, source: "https://pricing.test/official", asOf: "2026-10-01", provisional: false });
const provisional = (key: string, unit: RateCardRow["unit"]): RateCardRow => ({ key, price: null, unit, source: null, asOf: null, provisional: true });

const VERIFIED_ROWS: RateCardRow[] = [
  verified(bedrockRateKey("input"), 10, "PER_1M_TOKENS"),
  verified(bedrockRateKey("output"), 50, "PER_1M_TOKENS"),
  verified(bedrockRateKey("cacheRead"), 1, "PER_1M_TOKENS"),
  verified(bedrockRateKey("cacheWrite"), 12.5, "PER_1M_TOKENS"),
  verified(SES_OUTBOUND_RATE_KEY, 0.1, "PER_1K_MESSAGES"),
  verified(whatsappRateKey("utility"), 0.02, "PER_MESSAGE"),
  verified(whatsappRateKey("service"), 0, "PER_MESSAGE"),
];

const USAGE: DossierUsage = {
  tokens: { input: 300_000, output: 12_000, cacheRead: 900_000, cacheWrite: 40_000 },
  emails: 4,
  whatsapp: { utility: 5, service: 3 },
};

describe("dossierCost", () => {
  it("prices tokens and messages with the rate card, line by line", () => {
    const cost = dossierCost(USAGE, VERIFIED_ROWS, { whatsappSimulated: false });
    expect(cost.status).toBe("VERIFIED");
    if (cost.status !== "VERIFIED") return;
    expect(cost.lines.map((line) => [line.key, line.usd])).toEqual([
      ["bedrock:global.anthropic.claude-haiku-4-5-20251001-v1-0:input", 3],
      ["bedrock:global.anthropic.claude-haiku-4-5-20251001-v1-0:output", 0.6],
      ["bedrock:global.anthropic.claude-haiku-4-5-20251001-v1-0:cacheRead", 0.9],
      ["bedrock:global.anthropic.claude-haiku-4-5-20251001-v1-0:cacheWrite", 0.5],
      ["ses:outbound", 0.0004],
      ["whatsapp:AR:utility", 0.1],
      ["whatsapp:AR:service", 0],
    ]);
    expect(cost.usd).toBe(5.1004);
    expect(cost.whatsappPricedAsLive).toBe(false);
  });

  it("prices simulated WhatsApp as live and says so", () => {
    const cost = dossierCost(USAGE, VERIFIED_ROWS, { whatsappSimulated: true });
    expect(cost).toMatchObject({ status: "VERIFIED", whatsappPricedAsLive: true, usd: 5.1004 });
    expect(dossierCost({ ...USAGE, whatsapp: { utility: 0, service: 0 } }, VERIFIED_ROWS, { whatsappSimulated: true }).whatsappPricedAsLive).toBe(false);
  });

  it("shows no total while a needed rate is provisional or missing", () => {
    const rows = VERIFIED_ROWS.map((row) => (row.key === SES_OUTBOUND_RATE_KEY ? provisional(row.key, row.unit) : row)).filter((row) => row.key !== whatsappRateKey("service"));
    expect(dossierCost(USAGE, rows, { whatsappSimulated: true })).toEqual({ status: "UNVERIFIED", missingRates: ["ses:outbound", "whatsapp:AR:service"], whatsappPricedAsLive: true });
  });

  it("only needs the rates of what was consumed", () => {
    const tokensOnly = { ...USAGE, emails: 0, whatsapp: { utility: 0, service: 0 } };
    const rows = [...VERIFIED_ROWS.slice(0, 4), provisional(SES_OUTBOUND_RATE_KEY, "PER_1K_MESSAGES")];
    expect(dossierCost(tokensOnly, rows, { whatsappSimulated: false })).toMatchObject({ status: "VERIFIED", usd: 5 });
  });

  it("rejects malformed usage and rate rows, including a verified row without its source", () => {
    expect(() => dossierCost({ ...USAGE, emails: -1 }, VERIFIED_ROWS, { whatsappSimulated: false })).toThrow();
    expect(() => dossierCost(USAGE, [{ ...VERIFIED_ROWS[0], source: null }], { whatsappSimulated: false })).toThrow(/source/);
    expect(() => dossierCost(USAGE, [{ ...VERIFIED_ROWS[0], key: "bedrock" }], { whatsappSimulated: false })).toThrow();
  });
});

describe("hasProvisionalRates", () => {
  it("is true while the seed's provisional rows are in place", () => {
    expect(hasProvisionalRates(VERIFIED_ROWS)).toBe(false);
    expect(hasProvisionalRates([...VERIFIED_ROWS, provisional(whatsappRateKey("utility", "BR"), "PER_MESSAGE")])).toBe(true);
    expect(hasProvisionalRates([{ ...VERIFIED_ROWS[0], pk: "REF#RATECARD#GLOBAL" }])).toBe(false);
  });
});
