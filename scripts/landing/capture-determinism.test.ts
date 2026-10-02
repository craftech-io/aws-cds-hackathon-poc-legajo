// Two local runs of the console captures give the same pictures byte for byte (FL-129, docs/landing-spec.md
// §7.2.1): the moments of the guest's world are deterministic, real time is fixed on the server and in
// the page, motion is reduced and the fonts are loaded before the frame. Needs the installed Chrome
// (E2E_BROWSER_CHANNEL overrides it), as the UI specs do; it says so when the browser is missing.
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { captureLocal } from "./capture-console";
import { fallbackPng } from "./encode";

const CHANNEL = process.env.E2E_BROWSER_CHANNEL ?? "chrome";
const browserAvailable = await chromium.launch({ channel: CHANNEL }).then(
  async (browser) => (await browser.close(), true),
  () => false,
);

describe.skipIf(!browserAvailable)(`local captures are deterministic (${CHANNEL}) [FL-129]`, () => {
  it("[FL-129] gives the same PNG bytes twice for two views of two moments", async () => {
    const ids = ["console-audit", "console-dossier-reading"] as const;
    const first = await captureLocal(ids, ["desktop"], []);
    const second = await captureLocal(ids, ["desktop"], []);
    expect(first.map((frame) => frame.id)).toEqual([...second.map((frame) => frame.id)]);
    for (const [index, frame] of first.entries()) {
      const again = second[index];
      expect(again && Buffer.compare(frame.png, again.png), frame.id).toBe(0);
      expect(Buffer.compare(await fallbackPng(frame.png), await fallbackPng(again?.png ?? Buffer.alloc(0))), `${frame.id} fallback`).toBe(0);
    }
  }, 240_000);
});
