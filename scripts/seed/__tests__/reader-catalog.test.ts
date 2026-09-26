// The seed's PDFs through the real reader mock (docs/seed-spec.md §8-§9, docs/architecture-integrations.md
// §5): every catalogued PDF is recognized by its SHA-256 with exactly its ground truth, and a stored
// version's reading is what the mock answers for that file and idempotency key; a modified copy is
// still found by its embedded `LegajoDocId`; the three unknown documents are UNRECOGNIZED.
import { describe, expect, it } from "vitest";
import { Reading } from "@legajo/reader-contract";
import { createReaderApp } from "@legajo/reader-mock/app";
import { GroundTruthItem } from "@legajo/reader-mock/catalog";
import { createMemoryCatalog } from "@legajo/reader-mock/memory-catalog";
import { embeddedDocId } from "@legajo/reader-mock/pdf-meta";
import { documentsUrl, fakeDocumentsBucket } from "@legajo/reader-mock/testing";
import { INJECTION_PDF_TITLE } from "@legajo/bff/copy/en-supplier-sim";
import { readSeed } from "../lib/files";
import { sha256Hex } from "../lib/json";
import { pdfInfo, pdfTextLines } from "../lib/pdf";

const BUCKET = "legajo-poc-documentsbucket-seed";
const seed = readSeed();
const catalogItems = seed.tables.ReaderCatalog.items.map((item) => GroundTruthItem.parse(item));

function reader() {
  const catalog = createMemoryCatalog(catalogItems);
  const bucket = fakeDocumentsBucket();
  const app = createReaderApp({
    catalog,
    documentsBucket: BUCKET,
    fetchSource: bucket.fetch,
    extractDocId: embeddedDocId,
    now: () => new Date("2026-10-15T13:00:00.000Z"),
    random: () => 0,
    sleep: async () => undefined,
    onEvent: () => undefined,
  });
  return async (bytes: Uint8Array, key: string): Promise<Reading> => {
    const objectKey = `ops/seed/${sha256Hex(bytes).slice(0, 8)}/${key}.pdf`;
    bucket.put(objectKey, bytes);
    const response = await app({ method: "POST", path: "/v1/readings", headers: { "idempotency-key": key }, body: JSON.stringify({ source: { url: documentsUrl(BUCKET, objectKey) }, sha256: sha256Hex(bytes) }) });
    expect(response.statusCode, key).toBe(200);
    return Reading.parse(JSON.parse(response.body));
  };
}

const known = [...seed.pdfs].filter(([path]) => !path.startsWith("unknown/"));
const unknown = [...seed.pdfs].filter(([path]) => path.startsWith("unknown/"));

describe("reader catalog of the seed", () => {
  it("catalogues the 90 first versions and the 12 later ones by hash and by id, and leaves out the 3 unknown PDFs", () => {
    expect(known).toHaveLength(102);
    expect(known.filter(([path]) => path.endsWith("-v1.pdf"))).toHaveLength(90);
    expect(unknown).toHaveLength(3);
    expect(catalogItems).toHaveLength(204);
    for (const [path, bytes] of known) {
      const sha = sha256Hex(bytes);
      const docId = pdfInfo(bytes).LegajoDocId;
      expect(catalogItems.filter((item) => item.sha256 === sha && item.docId === docId), path).toHaveLength(2);
    }
    for (const [, bytes] of unknown) expect(catalogItems.some((item) => item.sha256 === sha256Hex(bytes))).toBe(false);
  });

  it("recognizes every catalogued PDF by its SHA-256 with its ground truth, and embeds the id PDF.js reads", async () => {
    const read = reader();
    for (const [path, bytes] of known) {
      const docId = pdfInfo(bytes).LegajoDocId ?? "";
      expect(await embeddedDocId(bytes), path).toBe(docId);
      const truth = catalogItems.find((item) => item.docId === docId);
      const reading = await read(bytes, docId.replaceAll("LDOC-", "k-"));
      expect(reading, path).toMatchObject({ status: "RECOGNIZED", matchedBy: "SHA256", docType: truth?.reading.docType, fields: truth?.reading.fields, observations: truth?.reading.observations });
    }
  });

  it("stores in every seeded version exactly the reading the mock answers for its file and its docVersionId", async () => {
    const read = reader();
    const versions = seed.tables.Operations.items.filter((item) => item.entity === "DocumentVersion");
    expect(versions.length).toBeGreaterThan(40);
    const bySha = new Map([...seed.pdfs].map(([, bytes]) => [sha256Hex(bytes), bytes]));
    for (const version of versions) {
      const bytes = bySha.get(String(version.sha256));
      expect(bytes, String(version.docVersionId)).toBeDefined();
      expect(await read(bytes ?? new Uint8Array(), String(version.docVersionId)), String(version.docVersionId)).toEqual(version.reading);
    }
  });

  it("finds a modified copy by its embedded LegajoDocId, with less confidence, and never recognizes an unknown PDF", async () => {
    const read = reader();
    const [path, original] = known.find(([candidate]) => candidate === "op-4471/PACKING_LIST-v1.pdf") ?? ["", new Uint8Array()];
    const copy = new Uint8Array(Buffer.concat([Buffer.from(original), Buffer.from("% re-saved copy\n", "latin1")]));
    const truth = catalogItems.find((item) => item.docId === "LDOC-4471-PL-v1");
    const byId = await read(copy, "copy-4471-PL-1");
    expect(byId, path).toMatchObject({ status: "RECOGNIZED", matchedBy: "EMBEDDED_ID", fields: truth?.reading.fields });
    expect(byId.confidence).toBeCloseTo((truth?.reading.confidence ?? 0) - 0.05, 4);
    for (const [unknownPath, bytes] of unknown) expect(await read(bytes, `unknown-${unknownPath.slice(-5, -4)}`), unknownPath).toMatchObject({ status: "UNRECOGNIZED", matchedBy: "NONE" });
  });

  it("plants the errors of §7 in the printed documents and their readings (op-4471: 12,480 kg against 12,840 kg)", () => {
    const pl = seed.pdfs.get("op-4471/PACKING_LIST-v1.pdf") ?? new Uint8Array();
    expect(pdfTextLines(pl)).toContain("Total gross weight: 12,480 kg");
    expect(pdfTextLines(seed.pdfs.get("op-4471/COMMERCIAL_INVOICE-v1.pdf") ?? new Uint8Array())).toContain("Total gross weight: 12,840 kg");
    expect(catalogItems.find((item) => item.docId === "LDOC-4471-PL-v1")?.reading.observations).toEqual([
      { code: "GROSS_WEIGHT_MISMATCH", severity: "BLOCKING", field: "grossWeightKg", expected: "12,840 kg", found: "12,480 kg", againstDocType: "COMMERCIAL_INVOICE" },
    ]);
    expect(catalogItems.find((item) => item.docId === "LDOC-4471-PL-v2")?.reading.observations).toEqual([]);
    const twice = ["LDOC-4479-CO-v1", "LDOC-4479-CO-v2"].map((docId) => catalogItems.find((item) => item.docId === docId)?.reading.observations?.[0]?.code);
    expect(twice).toEqual(["INVOICE_NUMBER_MISMATCH", "INVOICE_NUMBER_MISMATCH"]);
    expect(catalogItems.find((item) => item.docId === "LDOC-4485-PL-v1")?.reading.confidence).toBe(0.41);
  });

  it("marks every page synthetic, and gives the INJECTION supplier's PDFs the hostile Title, read like any other", () => {
    for (const [path, bytes] of seed.pdfs) {
      expect(pdfTextLines(bytes), path).toContain("SYNTHETIC — NOT A REAL DOCUMENT");
      expect(Buffer.from(bytes).toString("latin1"), path).not.toMatch(/CreationDate|ModDate/);
    }
    for (const docType of ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"]) expect(pdfInfo(seed.pdfs.get(`op-4483/${docType}-v1.pdf`) ?? new Uint8Array()).Title).toBe(INJECTION_PDF_TITLE);
    expect(catalogItems.find((item) => item.docId === "LDOC-4483-CI-v1")?.reading.status).toBe("RECOGNIZED");
  });
});
