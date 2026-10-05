import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MODES_FILE, PENDING_FILE, checkModes, isClosed, pendingStatus, readModes } from "./check-modes";

const modesSource = (whatsapp: string, email = "live") => `
export const channelModes = {
  email: "${email}",
  whatsapp: "${whatsapp}", // live only after docs/pending.md P-01 is closed
} as const satisfies Record<ChannelName, ChannelMode>;
`;

const pending = (p01: string) => `
| # | Pendiente | Dueño | Estado | Qué falta |
|---|---|---|---|---|
| P-01 | Conectar WhatsApp | CTO (Meta) | ${p01} | §1 |
| P-02 | Oportunidad ACE | CTO | Abierto | §2 |
`;

const OPEN = "Abierto";
const CLOSED = "Cerrado el 2026-10-10 por el CTO";

describe("readModes", () => {
  it("reads both modes as plain string literals", () => {
    expect(readModes(modesSource("simulated"))).toEqual({ email: "live", whatsapp: "simulated" });
  });

  it("ignores a mode that is not a plain literal on its own line", () => {
    expect(readModes(`whatsapp: process.env.WA ?? "simulated",`)).toEqual({});
  });
});

describe("pendingStatus and isClosed", () => {
  it("returns the Estado cell of the row with that id", () => {
    expect(pendingStatus(pending(OPEN), "P-01")).toBe(OPEN);
    expect(pendingStatus(pending(OPEN), "P-99")).toBeUndefined();
  });

  it("accepts only the closure format of docs/pending.md", () => {
    expect(isClosed(CLOSED)).toBe(true);
    expect(isClosed("Cerrada el 2026-10-10 por devops con el CTO")).toBe(true);
    expect(isClosed("Abierto")).toBe(false);
    expect(isClosed("Cerrado")).toBe(false);
    expect(isClosed("Cerrado pronto")).toBe(false);
  });
});

describe("checkModes [FL-100]", () => {
  it("passes while WhatsApp stays simulated", () => {
    expect(checkModes(modesSource("simulated"), pending(OPEN))).toEqual([]);
  });

  it("fails when WhatsApp is live and P-01 is open", () => {
    const errors = checkModes(modesSource("live"), pending(OPEN));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"whatsapp" is live');
    expect(errors[0]).toContain("P-01");
  });

  it("passes when WhatsApp is live and P-01 was closed", () => {
    expect(checkModes(modesSource("live"), pending(CLOSED))).toEqual([]);
  });

  it("fails when P-01 has no row, when a mode is missing or when email is not live", () => {
    expect(checkModes(modesSource("live"), "| # | Pendiente |\n|---|---|\n")[0]).toContain("has no row for P-01");
    expect(checkModes(`email: "live",\n`, pending(OPEN))[0]).toContain('"whatsapp" not found');
    expect(checkModes(modesSource("simulated", "simulated"), pending(OPEN))[0]).toContain('email must be "live"');
  });
});

describe("repository state", () => {
  it("the committed modes and pending list pass the check", () => {
    const root = resolve(__dirname, "../..");
    const modes = readFileSync(resolve(root, MODES_FILE), "utf8");
    const pendingMarkdown = readFileSync(resolve(root, PENDING_FILE), "utf8");
    expect(checkModes(modes, pendingMarkdown)).toEqual([]);
    expect(readModes(modes)).toEqual({ email: "live", whatsapp: "live" });
  });
});
