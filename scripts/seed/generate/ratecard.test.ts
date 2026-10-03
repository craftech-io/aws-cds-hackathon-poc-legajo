import { describe, expect, it } from "vitest";
import { RateCard } from "@legajo/bff/domain/reference";
import { RateCardRow, SES_OUTBOUND_RATE_KEY, TokenKind, WhatsAppPricing, bedrockRateKey, hasProvisionalRates, whatsappRateKey } from "@legajo/bff/services/ratecard";
import { rateCardProblems } from "../validate/structure";
import { worldView } from "../validate/world-view";
import { GATE, HAPPY_PATH_TURNS, RATE_CARD_AS_OF, VERIFIED_RATES, estimateCosts, priceOf, rateCardDrift, rateCardItems, rateCardRows } from "./ratecard";

const EXPECTED_KEYS = [...TokenKind.options.map((kind) => bedrockRateKey(kind)), SES_OUTBOUND_RATE_KEY, ...WhatsAppPricing.options.map((pricing) => whatsappRateKey(pricing))];

describe("verified rate card (WP-41)", () => {
  it("covers exactly the rows of docs/seed-spec.md §12, none provisional", () => {
    expect(rateCardItems().map((row) => row.rateId).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(hasProvisionalRates(rateCardRows())).toBe(false);
  });

  it("passes invariant 15: price, official source and date on every row", () => {
    expect(rateCardProblems(worldView("data", rateCardItems()))).toEqual([]);
    for (const row of rateCardItems()) {
      const rate = RateCard.parse(row);
      expect(rate.provisional).toBe(false);
      expect(rate.price).not.toBeNull();
      expect(rate.asOf).toBe(RATE_CARD_AS_OF);
      expect(new URL(rate.source ?? "").hostname).toMatch(/(^|\.)amazonaws\.com$|(^|\.)aws\.amazon\.com$/);
    }
    for (const row of rateCardRows()) expect(RateCardRow.safeParse(row).success).toBe(true);
  });

  it("prices each row as the sum of its price-list lines", () => {
    for (const rate of VERIFIED_RATES) expect(priceOf(rate)).toBeCloseTo(rate.lines.reduce((sum, line) => sum + line.usd, 0), 9);
    const byKey = new Map(rateCardRows().map((row) => [row.key, row.price] as const));
    expect(byKey.get(bedrockRateKey("input"))).toBe(5);
    expect(byKey.get(bedrockRateKey("output"))).toBe(25);
    expect(byKey.get(whatsappRateKey("utility"))).toBe(0.0256);
    expect(byKey.get(whatsappRateKey("service"))).toBe(0.005);
  });

  it("prices the gate, the happy path and the guest worst day with the verified card", () => {
    const estimate = estimateCosts(15);
    expect(estimate.perTurnUsd).toEqual({ min: 0.175, max: 0.325 });
    expect(estimate.happyPathDossierUsd.max).toBeCloseTo(0.325 * HAPPY_PATH_TURNS, 6);
    expect(estimate.gate.turns).toBe(GATE.turnsPerSuite * GATE.fullRuns + GATE.batchOperations * HAPPY_PATH_TURNS);
    expect(estimate.gate.usd.max).toBeCloseTo(0.325 * estimate.gate.turns, 6);
    expect(estimate.guestWorstDay).toMatchObject({ reserved: 15, turns: 1_500 + 120 * 15, emails: 1_500 + 200 * 15 });
    expect(estimate.guestWorstDay.usd.max).toBeCloseTo(0.325 * 3_300 + 4_500 * 0.0001, 6);
    expect(estimate.wafMonthlyUsd.min).toBeGreaterThan(9);
    expect(() => estimateCosts(31)).toThrow(RangeError);
  });

  it("reports drift between a committed seed and the verified card", () => {
    expect(rateCardDrift(rateCardItems())).toEqual([]);
    const provisional = rateCardItems().map((row) => ({ ...row, price: null, provisional: true }));
    expect(rateCardDrift(provisional).length).toBeGreaterThan(0);
    expect(rateCardDrift([...rateCardItems(), { entity: "RateCard", rateId: "ses:inbound" }])).toContain("RATECARD ses:inbound is not in the verified card");
  });
});
