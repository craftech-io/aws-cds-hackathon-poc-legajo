// The scale that draws a tour visual whole inside its slot (FitToSlot, docs/landing-spec.md §4.3).
import { describe, expect, it } from "vitest";
import { fitScale } from "./FitToSlot";

describe("fitScale [FL-127]", () => {
  it("scales down to the tighter side and never up", () => {
    expect(fitScale({ width: 358, height: 944 }, { width: 358, height: 472 })).toBe(0.5);
    expect(fitScale({ width: 716, height: 300 }, { width: 358, height: 472 })).toBe(0.5);
    expect(fitScale({ width: 300, height: 200 }, { width: 358, height: 472 })).toBe(1);
  });

  it("keeps the natural size while nothing is measured yet", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 358, height: 472 })).toBe(1);
    expect(fitScale({ width: 358, height: 400 }, { width: 0, height: 0 })).toBe(1);
  });
});
