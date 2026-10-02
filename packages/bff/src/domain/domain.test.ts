import { describe, expect, it } from "vitest";
import { EntityName, ZonedInstant, clockTtlSeconds, entryAt, isExpired, utcInstant, worldOfClock } from "./common";
import { parseDocVersionId, isBlocking } from "./documents";
import { Firm, matrixDefault } from "./firms";
import { canTransitionDossier } from "./operations";
import { isUsableContact } from "./parties";
import { ENTITIES, checkEntityItem, entitiesOf } from "./registry";
import { parseTimerKey, timerKeyOf } from "./timers";

describe("instants", () => {
  it("accepts ISO instants with a zone only, and canonicalizes them to UTC for sort keys", () => {
    expect(ZonedInstant.safeParse("2026-10-14T10:30:00-03:00").success).toBe(true);
    expect(ZonedInstant.safeParse("2026-10-14T13:30:00.000Z").success).toBe(true);
    expect(ZonedInstant.safeParse("2026-10-14T10:30:00").success).toBe(false);
    expect(ZonedInstant.safeParse("2026-10-14").success).toBe(false);
    expect(utcInstant("2026-10-14T10:30:00-03:00")).toBe("2026-10-14T13:30:00.000Z");
    // Lexicographic order of canonical instants is chronological whatever zone they were written in.
    expect(utcInstant("2026-10-15T01:00:00+05:30") < utcInstant("2026-10-14T21:00:00-03:00")).toBe(true);
    expect(() => utcInstant("not a date")).toThrow(RangeError);
    expect(isExpired(1_000, new Date(1_000_000))).toBe(true);
    expect(isExpired(1_001, new Date(1_000_000))).toBe(false);
    expect(isExpired(undefined, new Date())).toBe(false);
  });
});

describe("worlds", () => {
  it("stamps QA and guest worlds and lets only qa-* worlds expire", () => {
    expect(worldOfClock("qa-812-1-sc16")).toBe("qa");
    expect(worldOfClock("GLOBAL#firm-qa")).toBe("qa");
    expect(worldOfClock("GUEST#firm-guest-test")).toBe("qa");
    expect(worldOfClock("GUEST#firm-guest-01")).toBe("guest");
    expect(worldOfClock("GLOBAL#firm-delta")).toBeUndefined();
    expect(worldOfClock("sim-0001")).toBeUndefined();
    expect(clockTtlSeconds("qa-812-1-sc16")).toBe(48 * 3600);
    expect(clockTtlSeconds("GLOBAL#firm-qa")).toBeUndefined();
    expect(clockTtlSeconds("GUEST#firm-guest-01")).toBeUndefined();
  });

  it("tells a reserved guest firm from a public one", () => {
    const firm = {
      createdAt: "2026-09-25T12:00:00.000Z",
      updatedAt: "2026-09-25T12:00:00.000Z",
      version: 1,
      firmId: "firm-guest-31",
      name: "Estudio Delta",
      kind: "GUEST",
      mailboxAddress: "estudio-g31@sim.legajo.demo.craftech.io",
      businessHours: { timezone: "America/Argentina/Buenos_Aires", from: "09:00", to: "18:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"] },
      clockId: "GUEST#firm-guest-31",
    };
    expect(Firm.parse({ ...firm, guestKind: "PUBLIC" }).guestKind).toBe("PUBLIC");
    expect(Firm.parse({ ...firm, firmId: "firm-guest-01", guestKind: "RESERVED" }).guestKind).toBe("RESERVED");
    expect(Firm.safeParse({ ...firm, guestKind: "TRIAL" }).success).toBe(false);
  });

  it("finds the state of a history at a past simulated instant", () => {
    const history = [
      { atSim: "2026-10-14T10:00:00-03:00", control: "AGENT" },
      { atSim: "2026-10-15T10:00:00-03:00", control: "BROKER" },
    ];
    expect(entryAt(history, "2026-10-14T09:59:00-03:00")).toBeUndefined();
    expect(entryAt(history, "2026-10-15T13:00:00Z")?.control).toBe("BROKER");
    expect(entryAt(history, "2026-10-15T09:59:59-03:00")?.control).toBe("AGENT");
  });
});

describe("dossier rules", () => {
  it("lets only a human approval reach APPROVED, and only from READY_FOR_REVIEW", () => {
    expect(canTransitionDossier("OPEN", "READY_FOR_REVIEW")).toBe(true);
    expect(canTransitionDossier("OPEN", "APPROVED")).toBe(false);
    expect(canTransitionDossier("READY_FOR_REVIEW", "APPROVED")).toBe(true);
    expect(canTransitionDossier("APPROVED", "REOPENED")).toBe(true);
    expect(canTransitionDossier("APPROVED", "OPEN")).toBe(false);
    expect(canTransitionDossier("REOPENED", "APPROVED")).toBe(false);
  });

  it("resolves the matrix default: the document rule, then ANY, then the fallback", () => {
    const matrix = {
      fallback: "BROKER" as const,
      rules: [
        { docType: "ANY" as const, code: "LOW_CONFIDENCE" as const, responsible: "SENDER" as const },
        { docType: "COMMERCIAL_INVOICE" as const, code: "BUYER_DATA_MISMATCH" as const, responsible: "IMPORTER" as const, then: "SUPPLIER" as const },
        { docType: "PACKING_LIST" as const, code: "GROSS_WEIGHT_MISMATCH" as const, responsible: "SUPPLIER" as const },
      ],
    };
    expect(matrixDefault(matrix, "PACKING_LIST", "GROSS_WEIGHT_MISMATCH")).toEqual({ responsible: "SUPPLIER" });
    expect(matrixDefault(matrix, "COMMERCIAL_INVOICE", "BUYER_DATA_MISMATCH")).toEqual({ responsible: "IMPORTER", then: "SUPPLIER" });
    expect(matrixDefault(matrix, "CERTIFICATE_OF_ORIGIN", "LOW_CONFIDENCE")).toEqual({ responsible: "SENDER" });
    expect(matrixDefault(matrix, "CERTIFICATE_OF_ORIGIN", "INCOTERM_MISMATCH")).toEqual({ responsible: "BROKER" });
  });

  it("blocks only open blocking observations and writes only to confirmed ACTIVE contacts", () => {
    expect(isBlocking({ severity: "BLOCKING", status: "CORRECTION_REQUESTED" })).toBe(true);
    expect(isBlocking({ severity: "BLOCKING", status: "WAIVED_BY_BROKER" })).toBe(false);
    expect(isBlocking({ severity: "WARNING", status: "OPEN" })).toBe(false);
    expect(isUsableContact({ status: "ACTIVE", confirmedAt: "2026-10-15T10:07:00-03:00" })).toBe(true);
    expect(isUsableContact({ status: "ACTIVE", confirmedAt: undefined })).toBe(false);
    expect(isUsableContact({ status: "PENDING_CONFIRMATION", confirmedAt: undefined })).toBe(false);
  });
});

describe("ids and keys", () => {
  it("parses document version ids of demo and cloned operations", () => {
    expect(parseDocVersionId("dv-4471-PL-2")).toEqual({ operationId: "op-4471", docType: "PACKING_LIST", versionNo: 2 });
    expect(parseDocVersionId("dv-4471-g03-CO-1")).toEqual({ operationId: "op-4471-g03", docType: "CERTIFICATE_OF_ORIGIN", versionNo: 1 });
    expect(parseDocVersionId("dv-4471-XX-1")).toBeUndefined();
    expect(parseDocVersionId("dv-4471-PL-0")).toBeUndefined();
  });

  it("builds and parses timer keys", () => {
    expect(timerKeyOf("MILESTONE", "DOCS_REQUEST")).toBe("TIMER#MILESTONE#DOCS_REQUEST");
    expect(parseTimerKey("TIMER#DEFERRED_SEND#tm-01")).toEqual({ kind: "DEFERRED_SEND", timerId: "tm-01" });
    expect(parseTimerKey("TIMER#NOPE#x")).toBeUndefined();
    expect(() => timerKeyOf("MILESTONE", "bad id")).toThrow();
  });
});

describe("entity registry", () => {
  it("has a table and a schema for every entity", () => {
    expect(Object.keys(ENTITIES).sort()).toEqual([...EntityName.options].sort());
    expect(entitiesOf("LegajoMetrics")).toEqual(["DossierKpi"]);
    expect(entitiesOf("ReaderCatalog")).toEqual([]);
  });

  it("checks an item by its discriminator and its table", () => {
    const holiday = { PK: "REF#HOLIDAY#AR", SK: "2026-12-08", entity: "Holiday", createdAt: "2026-09-26T15:00:00.000Z", updatedAt: "2026-09-26T15:00:00.000Z", version: 1, synthetic: true, country: "AR", date: "2026-12-08", name: "Inmaculada Concepción de María", verified: false };
    expect(checkEntityItem("Reference", holiday)).toEqual({ ok: true, entity: "Holiday" });
    expect(checkEntityItem("Firms", holiday)).toMatchObject({ ok: false });
    expect(checkEntityItem("Reference", { ...holiday, entity: "Nope" })).toMatchObject({ ok: false, error: expect.stringContaining("unknown entity") });
    expect(checkEntityItem("Reference", { ...holiday, verified: "no" })).toMatchObject({ ok: false, error: expect.stringContaining("verified") });
  });
});
