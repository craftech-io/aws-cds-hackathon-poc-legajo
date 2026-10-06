import { describe, expect, it } from "vitest";
import { pickActive } from "./scroll-spy";

const IDS = ["tour", "guarantees", "integrations", "architecture", "faq"] as const;

describe("[FL-089] scroll-spy of the header", () => {
  it("[FL-089] has no current section while the band is over a section the header does not link", () => {
    expect(pickActive(IDS, new Set())).toBeUndefined();
    expect(pickActive(IDS, new Set(["problem"]))).toBeUndefined();
  });

  it("[FL-089] is the section crossing the band", () => {
    expect(pickActive(IDS, new Set(["guarantees"]))).toBe("guarantees");
  });

  it("[FL-089] takes the later of two sections that cross the band together (the one entering)", () => {
    expect(pickActive(IDS, new Set(["tour", "guarantees"]))).toBe("guarantees");
  });
});
