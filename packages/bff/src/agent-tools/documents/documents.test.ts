import { beforeEach, describe, expect, it } from "vitest";
import type { Reading } from "@legajo/reader-contract";
import { CLOCK, FIRM, REAL_NOW, START_SIM } from "../../connector/testing";
import type { CreateReadingInput } from "../../reader/client";
import { ReaderError } from "../../reader/errors";
import { gatewayContext } from "../common/principal";
import { type ToolWorld, OPERATION, auditRows, toolWorld } from "../common/testing";
import { createTestObservation, fileTestVersion, seedFirm } from "../operations/testing";
import { documentsImplementations } from "./handler";
import { createDocumentsTarget } from "./index";

const TOKEN = "Tq3x9vY2bN7mK4pL8rS1wE6uI0oA5dF3gH7jZ2cV9xB";

const GROSS = { code: "GROSS_WEIGHT_MISMATCH", severity: "BLOCKING", field: "grossWeightKg", expected: "12840", found: "12480" } as const;

function packingList(extra: Partial<Reading> = {}): Reading {
  return {
    readingId: "rd-pl",
    status: "RECOGNIZED",
    docType: "PACKING_LIST",
    matchedBy: "SHA256",
    confidence: 0.96,
    fields: { invoiceNumber: "QBT-2026-0917", grossWeightKg: 12480, buyerTaxId: "30-71234567-9", buyerName: "Norpampa Insumos SRL", packages: 40 },
    observations: [GROSS],
    readerVersion: "1.0.0",
    ...extra,
  };
}

describe("documents target", () => {
  let world: ToolWorld;
  let token: string;
  let script: (Reading | "FAIL")[];
  let readerCalls: CreateReadingInput[];

  function target() {
    return createDocumentsTarget(
      world.deps,
      documentsImplementations({
        reader: () => ({
          async createReading(input) {
            readerCalls.push(input);
            const next = script.shift();
            if (next === undefined) throw new Error("no reader answer scripted");
            if (next === "FAIL") throw new ReaderError("READER_UNAVAILABLE", "down", { attempts: 3, status: 503 });
            return next;
          },
        }),
        sourceUrl: async (key) => `https://documents.example.invalid/${key}`,
        newToken: () => TOKEN,
      }),
    );
  }

  async function call(tool: "read_document" | "create_upload_link", input: Record<string, unknown>) {
    return target().handle({ sessionToken: token, ...input }, gatewayContext(`documents___${tool}`));
  }

  beforeEach(async () => {
    world = await toolWorld();
    await seedFirm(world.stores);
    script = [];
    readerCalls = [];
    token = (await world.openTurn("DOCUMENT_READ")).token;
  });

  describe("read_document", () => {
    it("[FL-022] returns the reader's reading of a read version: type, source, fields the model may see and observations with their ids", async () => {
      const version = await fileTestVersion(world.stores, { docType: "PACKING_LIST", reading: packingList() });
      const result = await call("read_document", { docVersionId: version.docVersionId });
      expect(result).toEqual({
        ok: true,
        docType: "PACKING_LIST",
        versionNo: 1,
        source: { party: "SUPPLIER", channel: "EMAIL" },
        reading: {
          status: "RECOGNIZED",
          docType: "PACKING_LIST",
          confidence: 0.96,
          fields: { invoiceNumber: "QBT-2026-0917", grossWeightKg: 12480, packages: 40 },
          observations: [{ observationId: "obs-4471-PL-GROSS_WEIGHT_MISMATCH", code: "GROSS_WEIGHT_MISMATCH", label: "peso bruto distinto del de la factura", field: "grossWeightKg", expected: "12840", found: "12480", severity: "BLOCKING" }],
        },
      });
      // The buyer's tax id and name, the file and its storage never reach the model.
      expect(JSON.stringify(result)).not.toMatch(/30-71234567-9|Norpampa|s3Key|ops\//);
      expect(readerCalls).toEqual([]);
      // The result grounds the turn's messages.
      const turnId = (await world.stores.connector.runtime.listTurnResults("turn-T0001")).map((row) => row.tool);
      expect(turnId).toEqual(["read_document"]);
    });

    it("[FL-096] reads a version still waiting for its reading, with Idempotency-Key = its id, and applies it to the dossier", async () => {
      const version = await fileTestVersion(world.stores, { docType: "PACKING_LIST" });
      script.push(packingList());
      const result = await call("read_document", { docVersionId: version.docVersionId });
      expect(result).toMatchObject({ ok: true, docType: "PACKING_LIST", reading: { status: "RECOGNIZED" } });
      expect(readerCalls[0]).toMatchObject({ docVersionId: version.docVersionId, clockId: CLOCK, sourceUrl: expect.stringContaining(version.s3Key) });
      expect(await world.stores.connector.documents.getVersion(OPERATION, "PACKING_LIST", 1)).toMatchObject({ state: "READ", readerAttempts: 1 });
      expect(await world.stores.connector.documents.getObservation(OPERATION, "obs-4471-PL-GROSS_WEIGHT_MISMATCH")).toMatchObject({ status: "OPEN", attempts: 0 });
      expect((await world.stores.connector.documents.getDocument(OPERATION, "PACKING_LIST")).status).toBe("WITH_OBSERVATION");
    });

    it("[FL-096] a reader that still does not answer: UNAVAILABLE, nothing invented, the failure counted", async () => {
      const version = await fileTestVersion(world.stores, { docType: "PACKING_LIST" });
      script.push("FAIL");
      expect(await call("read_document", { docVersionId: version.docVersionId })).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(await world.stores.connector.documents.getVersion(OPERATION, "PACKING_LIST", 1)).toMatchObject({ state: "RECEIVED", readerAttempts: 1 });
      expect(await world.stores.connector.runtime.listTurnResults("turn-T0001")).toEqual([]);
    });

    it("[FL-026] an unrecognized version has no type of its own and no observations", async () => {
      const version = await fileTestVersion(world.stores, { docType: "COMMERCIAL_INVOICE", state: "UNRECOGNIZED", reading: { readingId: "rd-x", status: "UNRECOGNIZED", readerVersion: "1.0.0" } });
      expect(await call("read_document", { docVersionId: version.docVersionId })).toMatchObject({ ok: true, docType: "COMMERCIAL_INVOICE", reading: { status: "UNRECOGNIZED", fields: {}, observations: [] } });
    });

    it("a version of another operation is FORBIDDEN (LAM-OP-SCOPE); one that does not exist is NOT_FOUND", async () => {
      expect(await call("read_document", { docVersionId: "dv-4472-PL-1" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(await call("read_document", { docVersionId: "dv-4471-PL-9" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    });
  });

  describe("create_upload_link", () => {
    it("[FL-009] a 72-hour link for the importer of the turn's operation, only for its MISSING documents", async () => {
      const result = await call("create_upload_link", { docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] });
      expect(result).toEqual({ ok: true, url: `https://legajo.demo.craftech.io/u/${TOKEN}`, token: TOKEN, expiresAtText: "29/09 12:00" });
      const link = await world.stores.connector.runtime.getUploadLink(TOKEN);
      expect(link).toMatchObject({ operationId: OPERATION, importerId: "imp-norpampa", firmId: FIRM, clockId: CLOCK, docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"], createdAtReal: REAL_NOW, turnId: "turn-T0001" });
      expect(Date.parse(link?.expiresAtReal ?? "") - Date.parse(REAL_NOW)).toBe(72 * 3_600_000);
      const audit = (await auditRows(world)).filter((row) => row.action === "UPLOAD_LINK_CREATED");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ decision: "ACTION", actor: "AGENT" });
      // The bearer token never goes to the audit log.
      expect(JSON.stringify(audit)).not.toContain(TOKEN);
    });

    it("refuses a document the importer is not the one to bring, and writes no link", async () => {
      await world.stores.connector.documents.updateDocument(OPERATION, "COMMERCIAL_INVOICE", { status: "VALID", validatedBy: "READER" });
      const version = await fileTestVersion(world.stores, { docType: "PACKING_LIST" });
      await world.stores.connector.documents.updateDocument(OPERATION, "PACKING_LIST", { status: "WITH_OBSERVATION" });
      await createTestObservation(world.stores, { docType: "PACKING_LIST", code: "GROSS_WEIGHT_MISMATCH", docVersionId: version.docVersionId, responsibleParty: "SUPPLIER" });
      const result = await call("create_upload_link", { docTypes: ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] });
      expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT", message: expect.stringContaining("COMMERCIAL_INVOICE, PACKING_LIST") } });
      expect(await world.stores.connector.runtime.getUploadLink(TOKEN)).toBeUndefined();
      expect((await auditRows(world)).find((row) => row.action === "UPLOAD_LINK_CREATED")).toMatchObject({ decision: "DENY", reason: "NOT_FOR_IMPORTER" });
    });

    it("admits a document WITH_OBSERVATION whose correction is the importer's", async () => {
      const version = await fileTestVersion(world.stores, { docType: "COMMERCIAL_INVOICE", party: "IMPORTER", channel: "WHATSAPP" });
      await world.stores.connector.documents.updateDocument(OPERATION, "COMMERCIAL_INVOICE", { status: "WITH_OBSERVATION" });
      await createTestObservation(world.stores, { docType: "COMMERCIAL_INVOICE", code: "LOW_CONFIDENCE", docVersionId: version.docVersionId, responsibleParty: "IMPORTER" });
      expect(await call("create_upload_link", { docTypes: ["COMMERCIAL_INVOICE"] })).toMatchObject({ ok: true, token: TOKEN });
    });

    it("an approved dossier takes no uploads", async () => {
      const { operations } = world.stores.connector;
      await operations.transitionDossier({ operationId: OPERATION, to: "READY_FOR_REVIEW", atSim: START_SIM, by: "SYSTEM" });
      await operations.transitionDossier({ operationId: OPERATION, to: "APPROVED", approvedBy: "brk-delta-diego", atSim: START_SIM, by: "BROKER:brk-delta-diego" });
      expect(await call("create_upload_link", { docTypes: ["PACKING_LIST"] })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    });

    it("the worker renders it in process for a template, as a direct caller of the operation", async () => {
      const result = await target().invoke("create_upload_link", { caller: { kind: "WORKER", firmId: FIRM, eventId: "evt_TEST" }, operationId: OPERATION, docTypes: ["PACKING_LIST"] });
      expect(result).toMatchObject({ ok: true, token: TOKEN });
      expect((await world.stores.connector.runtime.getUploadLink(TOKEN))?.turnId).toBeUndefined();
    });
  });
});
