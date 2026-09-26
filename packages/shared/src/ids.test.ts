import { describe, expect, it } from "vitest";
import {
  JUDGE_TEST_CLOCK_ID,
  QA_FIRM_IDS,
  QA_GLOBAL_CLOCK_ID,
  ClockId,
  clockScopeOf,
  globalClockId,
  judgeClockId,
  parseClockId,
  qaClockId,
  simClockId,
} from "./clock-ids";
import {
  DOC_TYPE_SHORT,
  FirmId,
  ID_PREFIX,
  ObservationId,
  OperationId,
  SyntheticDocId,
  docTypeFromShort,
  docVersionId,
  idSchema,
  isId,
  kindOfId,
  makeId,
  observationId,
  operationId,
  operationKey,
  operationNumberOf,
  operationNumberRange,
  padVersion,
  parseSyntheticDocId,
  syntheticDocId,
  versionTag,
} from "./ids";
import { readDoc, tableRows } from "./testing";

const SEED_SPEC = readDoc("docs/seed-spec.md");
const ID_TOKEN = /`((?:firm|brk|imp|sup|ctc|op|dv|obs|msg|LDOC)-[^`\s]+)`/g;

describe("prefixes", () => {
  it("follow docs/seed-spec.md §2", () => {
    expect(ID_PREFIX).toMatchSnapshot();
    const formats = tableRows(SEED_SPEC, "| Entidad | Formato | Ejemplos").map((cells) => /^`([A-Za-z]+)-/.exec(cells[1] ?? "")?.[1]);
    expect(formats.filter((prefix) => prefix !== "LDOC").sort()).toEqual(Object.values(ID_PREFIX).sort());
  });

  it("every concrete id the docs cite is valid for its prefix", () => {
    const docs = ["docs/seed-spec.md", "docs/flows-catalog.md", "docs/tool-catalog.md", "docs/test-plan.md", "docs/architecture.md", "CONTEXT.md"];
    const invalid: string[] = [];
    let checked = 0;
    for (const doc of docs) {
      for (const match of readDoc(doc).matchAll(ID_TOKEN)) {
        const token = match[1] ?? "";
        // Placeholders (`imp-qa-<runId>-…`), ranges (`firm-judge-01..NN`), addresses and wildcards.
        if (/[<>*@#…]|\.\./.test(token)) continue;
        checked += 1;
        const valid = token.startsWith("LDOC-") ? SyntheticDocId.safeParse(token).success : kindOfId(token) !== undefined;
        if (!valid) invalid.push(`${doc}: ${token}`);
      }
    }
    expect(invalid).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });
});

describe("validation", () => {
  it("accepts the fixtures of the seed", () => {
    expect(isId("firm", "firm-delta")).toBe(true);
    expect(isId("firm", "firm-judge-test")).toBe(true);
    expect(isId("broker", "brk-delta-diego")).toBe(true);
    expect(isId("importer", "imp-norpampa")).toBe(true);
    expect(isId("importer", "imp-qa-local-01J9ZQX-sc16-b")).toBe(true);
    expect(isId("supplier", "sup-n-elbhafen")).toBe(true);
    expect(isId("contact", "ctc-qingdao-1")).toBe(true);
    expect(isId("operation", "op-4471")).toBe(true);
    expect(isId("operation", "op-4471-j03")).toBe(true);
    expect(isId("docVersion", "dv-4471-PL-1")).toBe(true);
    expect(isId("observation", "obs-4471-PL-GROSS_WEIGHT_MISMATCH")).toBe(true);
    expect(isId("message", "msg-01J9ZQX4V7K2")).toBe(true);
  });

  it("rejects wrong prefixes, empty or malformed bodies and non-strings", () => {
    expect(isId("firm", "firm-Delta")).toBe(false);
    expect(isId("firm", "firm-")).toBe(false);
    expect(isId("firm", "firm-delta-")).toBe(false);
    expect(isId("importer", "sup-qingdao")).toBe(false);
    expect(isId("operation", "op-447")).toBe(false);
    expect(isId("operation", "op-4471-J03")).toBe(false);
    expect(isId("docVersion", "dv-4471-XX-1")).toBe(false);
    expect(isId("docVersion", "dv-4471-PL-0")).toBe(false);
    expect(isId("observation", "obs-4471-PL-UNKNOWN_CODE")).toBe(false);
    expect(isId("contact", "ctc-a b")).toBe(false);
    expect(isId("firm", 42)).toBe(false);
  });

  it("zod schemas carry a readable message", () => {
    expect(FirmId.safeParse("firm-norte").success).toBe(true);
    const result = OperationId.safeParse("firm-norte");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('"op-…"');
    expect(idSchema("contact").safeParse("ctc-konkan-2").success).toBe(true);
  });

  it("recognizes the kind of an id", () => {
    expect(kindOfId("brk-qa-runner")).toBe("broker");
    expect(kindOfId("obs-4479-CO-INVOICE_NUMBER_MISMATCH")).toBe("observation");
    expect(kindOfId("dv-4471-j03-CI-2")).toBe("docVersion");
    expect(kindOfId("unknown-thing")).toBeUndefined();
    expect(kindOfId("nodash")).toBeUndefined();
    expect(kindOfId("op-abcd")).toBeUndefined();
  });
});

describe("builders", () => {
  it("makeId validates what it builds", () => {
    expect(makeId("supplier", "n", "qingdao")).toBe("sup-n-qingdao");
    expect(() => makeId("supplier", "")).toThrow(RangeError);
    expect(() => makeId("firm", "Delta")).toThrow(RangeError);
  });

  it("operation ids, keys and numbers", () => {
    expect(operationId("4471")).toBe("op-4471");
    expect(operationId("4471", "j03")).toBe("op-4471-j03");
    expect(() => operationId("471")).toThrow();
    expect(operationKey("op-4471-j03")).toBe("4471-j03");
    expect(operationNumberOf("op-4471-j03")).toBe("4471");
  });

  it("document versions, observations and synthetic documents", () => {
    expect(docVersionId("op-4471", "PACKING_LIST", 1)).toBe("dv-4471-PL-1");
    expect(docVersionId("op-4471-j03", "COMMERCIAL_INVOICE", 2)).toBe("dv-4471-j03-CI-2");
    expect(() => docVersionId("op-4471", "PACKING_LIST", 0)).toThrow(RangeError);
    expect(observationId("op-4471", "PACKING_LIST", "GROSS_WEIGHT_MISMATCH")).toBe("obs-4471-PL-GROSS_WEIGHT_MISMATCH");
    expect(ObservationId.safeParse(observationId("op-4486", "CERTIFICATE_OF_ORIGIN", "MISSING_SIGNATURE")).success).toBe(true);
    expect(syntheticDocId("4471", "PACKING_LIST", 1)).toBe("LDOC-4471-PL-v1");
    expect(parseSyntheticDocId("LDOC-4479-CO-v2")).toEqual({ operationNumber: "4479", docType: "CERTIFICATE_OF_ORIGIN", versionNo: 2 });
    expect(parseSyntheticDocId("LDOC-4479-XX-v2")).toBeUndefined();
    expect(parseSyntheticDocId("LDOC-4479-CO-v0")).toBeUndefined();
  });

  it("short document codes go both ways", () => {
    expect(DOC_TYPE_SHORT).toEqual({ COMMERCIAL_INVOICE: "CI", PACKING_LIST: "PL", CERTIFICATE_OF_ORIGIN: "CO" });
    expect(docTypeFromShort("CO")).toBe("CERTIFICATE_OF_ORIGIN");
    expect(docTypeFromShort("BL")).toBeUndefined();
  });

  it("operation number ranges of docs/architecture.md §5", () => {
    expect(operationNumberRange("4471")).toBe("delta");
    expect(operationNumberRange("5506")).toBe("norte");
    expect(operationNumberRange("7123")).toBe("qa");
    expect(operationNumberRange("9999")).toBeUndefined();
  });

  it("version tags are zero-padded so the latest sorts first in a descending query", () => {
    expect(versionTag(1)).toBe("v001");
    expect(versionTag(42)).toBe("v042");
    expect(padVersion(7)).toBe("007");
    expect(() => versionTag(-1)).toThrow(RangeError);
    expect(() => padVersion(1.5)).toThrow(RangeError);
  });
});

describe("clock ids", () => {
  it("parse the four kinds of world clock", () => {
    expect(parseClockId("GLOBAL#firm-delta")).toEqual({ scope: "GLOBAL", firmId: "firm-delta" });
    expect(parseClockId("JUDGE#firm-judge-03")).toEqual({ scope: "JUDGE", firmId: "firm-judge-03" });
    expect(parseClockId("qa-812-1-sc18-rate")).toEqual({ scope: "QA" });
    expect(parseClockId("sim-0042")).toEqual({ scope: "SIM" });
    expect(clockScopeOf(QA_GLOBAL_CLOCK_ID)).toBe("GLOBAL");
    expect(clockScopeOf(JUDGE_TEST_CLOCK_ID)).toBe("JUDGE");
  });

  it("reject anything else", () => {
    for (const value of ["LOCAL#firm-delta", "GLOBAL#delta", "GLOBAL#", "qa-", "qa-bad id", "sim-", "firm-delta"]) {
      expect(parseClockId(value), value).toBeUndefined();
      expect(ClockId.safeParse(value).success, value).toBe(false);
    }
    expect(() => clockScopeOf("nope")).toThrow(RangeError);
  });

  it("builders produce parseable ids", () => {
    expect(globalClockId("firm-norte")).toBe("GLOBAL#firm-norte");
    expect(judgeClockId("firm-judge-01")).toBe("JUDGE#firm-judge-01");
    expect(qaClockId("local-01J9ZQX", "sc16")).toBe("qa-local-01J9ZQX-sc16");
    expect(simClockId("0007")).toBe("sim-0007");
    expect(() => globalClockId("delta")).toThrow();
    expect(() => qaClockId("812 1", "sc16")).toThrow();
  });

  it("QA firms are the three firms of QA type", () => {
    expect(QA_FIRM_IDS).toEqual(["firm-qa", "firm-sim", "firm-judge-test"]);
    for (const firmId of QA_FIRM_IDS) expect(FirmId.safeParse(firmId).success).toBe(true);
    expect(QA_GLOBAL_CLOCK_ID).toBe(globalClockId("firm-qa"));
    expect(JUDGE_TEST_CLOCK_ID).toBe(judgeClockId("firm-judge-test"));
  });
});
