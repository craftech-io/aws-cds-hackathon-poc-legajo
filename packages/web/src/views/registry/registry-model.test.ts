import { describe, expect, it } from "vitest";
import type { ApiError } from "../../lib/api-error";
import { changeRequest } from "./registry-api";
import { type ImporterRow, authorizationViews, authorizedNames, consentSummary, isCountryCode, isE164, isTimeZone, operationsOf, parseContactLines, profileLines, registryErrorText } from "./registry-model";

const SUPPLIERS = [
  { supplierId: "sup-qingdao", name: "Qingdao Bluewave Textiles Co., Ltd." },
  { supplierId: "sup-ligurmare", name: "Ligurmare Valve Works S.r.l." },
];

const NORPAMPA = {
  importerId: "imp-norpampa",
  name: "Norpampa Insumos SRL",
  contactName: "Lucía Benítez",
  phoneMasked: "+54*******0101",
  language: "es",
  consent: { status: "GRANTED", grantedAt: "2026-09-30T12:00:00-03:00", medium: "SIGNED_FORM", textVersion: "v1" },
  authorizations: [
    { supplierId: "sup-qingdao", authorized: true, authorizedAt: "2026-09-30T12:05:00-03:00" },
    { supplierId: "sup-ligurmare", authorized: false },
  ],
} as ImporterRow;

function apiError(overrides: Partial<ApiError>): ApiError {
  return { kind: "forbidden", code: "FORBIDDEN", httpStatus: 403, reason: null, correlationId: null, message: "refused", ...overrides };
}

describe("opt-in and authorizations as the registry shows them", () => {
  it("reads the opt-in with its date, medium and text version, a revocation, or its absence", () => {
    expect(consentSummary(NORPAMPA.consent)).toEqual({ text: "Vigente desde mié 30/09 12:00 · Formulario firmado · texto v1", tone: "success" });
    expect(consentSummary({ status: "REVOKED", revokedAt: "2026-10-15T11:00:00-03:00" })).toEqual({ text: "Revocado el jue 15/10 11:00", tone: "warning" });
    expect(consentSummary({ status: "NONE" })).toEqual({ text: "Sin opt-in", tone: "neutral" });
  });

  it("lists every supplier of the firm with whether the importer authorized it", () => {
    expect(authorizationViews(NORPAMPA, SUPPLIERS)).toEqual([
      { supplierId: "sup-qingdao", supplierName: "Qingdao Bluewave Textiles Co., Ltd.", authorized: true, since: "mié 30/09 12:05" },
      { supplierId: "sup-ligurmare", supplierName: "Ligurmare Valve Works S.r.l.", authorized: false, since: undefined },
    ]);
    expect(authorizedNames(NORPAMPA, SUPPLIERS)).toEqual(["Qingdao Bluewave Textiles Co., Ltd."]);
    expect(authorizedNames({ authorizations: [] }, SUPPLIERS)).toEqual([]);
  });
});

describe("the measured supplier profile", () => {
  it("reads the measurements when the list carries them, and nothing otherwise", () => {
    expect(profileLines({ profile: { medianReplyHours: 6.5, repliesMeasured: 4, bounces: 1, lateDocTypes: ["CERTIFICATE_OF_ORIGIN"] } })).toEqual([
      "Responde en ~6,5 h (4 respuestas)",
      "1 rebote",
      "Suele demorar: certificado de origen",
    ]);
    expect(profileLines({ profile: { repliesMeasured: 0, bounces: 0 } })).toEqual([]);
    expect(profileLines({ supplierId: "sup-qingdao" })).toEqual([]);
    expect(profileLines({ profile: { bounces: -1 } })).toEqual([]);
  });
});

describe("what the registry's forms send", () => {
  it("validates phones, countries, zones and the contacts textarea before anything leaves", () => {
    expect(isE164("+5491155500101")).toBe(true);
    expect(isE164("011 5550-0101")).toBe(false);
    expect(isCountryCode("CN")).toBe(true);
    expect(isCountryCode("China")).toBe(false);
    expect(isTimeZone("Asia/Shanghai")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(parseContactLines(" Supplier-Qingdao@sim.legajo.demo.craftech.io\n\nsupplier-qingdao@sim.legajo.demo.craftech.io\n")).toEqual(["supplier-qingdao@sim.legajo.demo.craftech.io"]);
    expect(parseContactLines("not an email")).toBeUndefined();
    expect(parseContactLines("")).toEqual([]);
  });

  it("builds each change with only the fields its procedure declares", () => {
    expect(changeRequest({ kind: "recordConsent", input: { importerId: "imp-norpampa", medium: "SIGNED_FORM", grantedAt: "2026-10-14T10:30:00-03:00", textVersion: "v1" } })).toEqual({
      path: "registry.consent.record",
      input: { importerId: "imp-norpampa", medium: "SIGNED_FORM", grantedAt: "2026-10-14T10:30:00-03:00", textVersion: "v1" },
    });
    expect(changeRequest({ kind: "setAuthorization", input: { importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: false } }).path).toBe("registry.authorization.set");
    expect(changeRequest({ kind: "upsertContact", input: { supplierId: "sup-qingdao", email: " New@Sim.Legajo.Demo.Craftech.io " } }).input).toEqual({ supplierId: "sup-qingdao", email: "new@sim.legajo.demo.craftech.io" });
    expect(changeRequest({ kind: "setBehaviour", input: { supplierId: "sup-qingdao", behaviour: "SEEDED_ERROR", operationId: "op-4471" } }).path).toBe("registry.supplierBehaviour.set");
  });

  it("refuses a new importer without phone and any field the procedure does not declare", () => {
    expect(() => changeRequest({ kind: "upsertImporter", input: { name: "Norpampa", contactName: "Lucía Benítez", contactFirstName: "Lucía", language: "es" } })).toThrow();
    const extra = { importerId: "imp-norpampa", firmId: "firm-norte" } as unknown as { importerId: string };
    expect(() => changeRequest({ kind: "revokeConsent", input: extra })).toThrow();
  });
});

describe("refusals in the registry's words", () => {
  it("explains the recipient fence and a duplicated address, and falls back to the shared texts", () => {
    expect(registryErrorText(apiError({ reason: "RECIPIENT_NOT_ALLOWED" }))).toContain("cerco de destinatarios");
    expect(registryErrorText(apiError({ kind: "conflict", code: "CONFLICT", reason: "CONFLICT" }))).toContain("ya pertenece");
    expect(registryErrorText(apiError({ reason: "CROSS_FIRM" }))).toBe("Ese dato no pertenece a tu estudio.");
    expect(registryErrorText(apiError({ kind: "invalid", code: "BAD_REQUEST" }))).toBe("Los datos no pasaron la validación.");
  });

  it("offers a supplier's own operations for its simulated behaviour", () => {
    const operations = [
      { operationId: "op-4478", operationNumber: "4478", supplierId: "sup-ligurmare" },
      { operationId: "op-4471", operationNumber: "4471", supplierId: "sup-qingdao" },
    ];
    expect(operationsOf("sup-qingdao", operations).map((operation) => operation.operationNumber)).toEqual(["4471"]);
  });
});
