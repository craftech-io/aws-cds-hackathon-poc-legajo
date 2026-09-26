import { describe, expect, it } from "vitest";
import { CONSOLE_CHANGE_INPUTS, isConsoleChangePath } from "./console-inputs";

const parses = (path: keyof typeof CONSOLE_CHANGE_INPUTS, input: unknown): boolean => CONSOLE_CHANGE_INPUTS[path].safeParse(input).success;

describe("console change inputs: one shape per procedure for the console, the scenarios and the BFF", () => {
  it("classifies or discards an unrecognized version inside its operation", () => {
    expect(parses("dossier.classifyDocument", { operationId: "op-4477", docVersionId: "dv-4477-CO-1", outcome: "CLASSIFY", docType: "CERTIFICATE_OF_ORIGIN" })).toBe(true);
    expect(parses("dossier.classifyDocument", { operationId: "op-4477", docVersionId: "dv-4477-CO-1", outcome: "DISCARD" })).toBe(true);
    // The shapes each caller used to send on its own: without the operation, without the outcome, a type on a discard.
    expect(parses("dossier.classifyDocument", { docVersionId: "dv-4477-CO-1", docType: "CERTIFICATE_OF_ORIGIN" })).toBe(false);
    expect(parses("dossier.classifyDocument", { operationId: "op-4477", docVersionId: "dv-4477-CO-1", outcome: "CLASSIFY" })).toBe(false);
    expect(parses("dossier.classifyDocument", { operationId: "op-4477", docVersionId: "dv-4477-CO-1", outcome: "DISCARD", docType: "PACKING_LIST" })).toBe(false);
  });

  it("waives an observation of the operation it names, with a reason", () => {
    expect(parses("dossier.waiveObservation", { operationId: "op-4486", observationId: "obs-4486-CO-MISSING_SIGNATURE", reason: "Presentado en papel." })).toBe(true);
    expect(parses("dossier.waiveObservation", { observationId: "obs-4486-CO-MISSING_SIGNATURE", reason: "Presentado en papel." })).toBe(false);
    expect(parses("dossier.waiveObservation", { operationId: "op-4486", observationId: "obs-4486-CO-MISSING_SIGNATURE", reason: " " })).toBe(false);
  });

  it("records an opt-in with the firm's own date, in the world it names or the firm's only one", () => {
    const grant = { importerId: "imp-norpampa", medium: "SIGNED_FORM", grantedAt: "2026-10-14T10:30:00-03:00", textVersion: "v1" };
    expect(parses("registry.consent.record", grant)).toBe(true);
    expect(parses("registry.consent.record", { ...grant, clockId: "qa-812-1-sc16" })).toBe(true);
    const { grantedAt: _omitted, ...withoutDate } = grant;
    expect(parses("registry.consent.record", { ...withoutDate, clockId: "qa-812-1-sc16" })).toBe(false);
    expect(parses("registry.consent.record", { ...grant, firmId: "firm-norte" })).toBe(false);
  });

  it("takes an optional world on every registry change and the reset, and nothing undeclared", () => {
    const clockId = "qa-812-1-sc16";
    expect(parses("registry.authorization.set", { clockId, importerId: "imp-qa-812-1-sc16-c", supplierId: "sup-qa-812-1-sc16-c", authorized: true })).toBe(true);
    expect(parses("registry.authorization.set", { importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: false })).toBe(true);
    expect(parses("registry.suppliers.upsert", { clockId, name: "Proveedor de prueba (ficticio)", country: "CN", timezone: "Asia/Shanghai", language: "en", contacts: ["qa-812-1-sc16-reg@sim.legajo.demo.craftech.io"] })).toBe(true);
    expect(parses("registry.suppliers.upsert", { clockId, name: "Proveedor de prueba (ficticio)", country: "CN", timezone: "Asia/Shanghai", language: "en", contacts: [{ email: "qa-812-1-sc16-reg@sim.legajo.demo.craftech.io" }] })).toBe(false);
    expect(parses("registry.supplierBehaviour.set", { clockId, supplierId: "sup-qingdao", behaviour: "PROMPT", extra: 1 })).toBe(false);
    expect(parses("clock.reset", {})).toBe(true);
    expect(parses("clock.reset", { clockId: "GLOBAL#firm-qa" })).toBe(true);
    expect(parses("clock.reset", { clockId: "not a clock" })).toBe(false);
  });

  it("knows its own paths only", () => {
    expect(isConsoleChangePath("registry.consent.record")).toBe(true);
    expect(isConsoleChangePath("operations.get")).toBe(false);
    expect(isConsoleChangePath("toString")).toBe(false);
  });
});
