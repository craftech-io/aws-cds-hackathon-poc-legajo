// Fixtures of the `operations` and `documents` tool tests: the firm of the demo slice (name, checklists,
// responsibility matrix), the dispatch glossary and helpers that file a version and its observation the
// way the intake leaves them. Rows are seeded through the seed store, as `seed:load` writes them.
import type { DocType, ObservationCode, Party } from "@legajo/shared";
import { observationId } from "@legajo/shared";
import { CLOCK, FIRM, REAL_NOW, START_SIM } from "../../connector/testing";
import type { MemoryStores } from "../../connector/memory/index";
import type { DocumentVersion, Observation } from "../../domain/documents";
import { OPERATION } from "../common/testing";

const META = { createdAt: REAL_NOW, updatedAt: REAL_NOW, version: 1, synthetic: true };

export const FIRM_NAME = "Estudio Delta";

/** The matrix rows the tests rely on (docs/seed-spec.md §11). */
export const MATRIX_RULES = [
  { docType: "PACKING_LIST", code: "GROSS_WEIGHT_MISMATCH", responsible: "SUPPLIER" },
  { docType: "CERTIFICATE_OF_ORIGIN", code: "MISSING_SIGNATURE", responsible: "SUPPLIER" },
  { docType: "COMMERCIAL_INVOICE", code: "BUYER_DATA_MISMATCH", responsible: "IMPORTER", then: "SUPPLIER" },
  { docType: "ANY", code: "LOW_CONFIDENCE", responsible: "SENDER" },
] as const;

export async function seedFirm(stores: MemoryStores): Promise<void> {
  await stores.seed.loadItems("Firms", [
    {
      PK: `FIRM#${FIRM}`,
      SK: "META",
      entity: "Firm",
      ...META,
      firmId: FIRM,
      name: FIRM_NAME,
      kind: "DEMO",
      mailboxAddress: "estudio-delta@sim.legajo.demo.craftech.io",
      clockId: CLOCK,
      businessHours: { timezone: "America/Argentina/Buenos_Aires", from: "09:00", to: "18:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"] },
    },
    { PK: `FIRM#${FIRM}`, SK: "CHECKLIST#PACKING_LIST#v001", entity: "Checklist", ...META, firmId: FIRM, docType: "PACKING_LIST", checklistVersion: 1, items: [{ itemId: "PL-01", docType: "PACKING_LIST", text: "Peso bruto igual al de la factura", required: true }] },
    { PK: `FIRM#${FIRM}`, SK: "CHECKLIST#PACKING_LIST#v002", entity: "Checklist", ...META, firmId: FIRM, docType: "PACKING_LIST", checklistVersion: 2, items: [{ itemId: "PL-02", docType: "PACKING_LIST", text: "Cantidad de bultos declarada", required: true }] },
    { PK: `FIRM#${FIRM}`, SK: "CHECKLIST#CERTIFICATE_OF_ORIGIN#v001", entity: "Checklist", ...META, firmId: FIRM, docType: "CERTIFICATE_OF_ORIGIN", checklistVersion: 1, items: [{ itemId: "CO-01", docType: "CERTIFICATE_OF_ORIGIN", text: "Firmado y sellado por la entidad emisora", required: true }] },
    { PK: `FIRM#${FIRM}`, SK: "RESP_MATRIX#v001", entity: "ResponsibilityMatrix", ...META, firmId: FIRM, matrixVersion: 1, rules: MATRIX_RULES.map((rule) => ({ ...rule })) },
  ]);
  await stores.seed.loadItems("Reference", [
    { PK: "REF#DISPATCH_GLOSSARY#es-AR", SK: "CANAL_ASIGNADO#NARANJA", entity: "DispatchGlossary", ...META, status: "CANAL_ASIGNADO", channel: "NARANJA", text: "La aduana va a revisar la documentación.", gloss: "Customs will review the documents." },
  ]);
}

export interface FiledVersion {
  readonly docType: DocType;
  readonly party?: Party;
  readonly channel?: DocumentVersion["source"]["channel"];
  readonly state?: DocumentVersion["state"];
  readonly reading?: DocumentVersion["reading"];
  readonly sha256?: string;
}

/** Files the next version of a document of op-4471 as the intake would (no reading unless given). */
export async function fileTestVersion(stores: MemoryStores, input: FiledVersion): Promise<DocumentVersion> {
  const { documents } = stores.connector;
  const document = await documents.getDocument(OPERATION, input.docType);
  const versionNo = document.currentVersion + 1;
  const { version } = await documents.addVersion({
    version: {
      operationId: OPERATION,
      clockId: CLOCK,
      docType: input.docType,
      versionNo,
      s3Key: `ops/${OPERATION}/${input.docType}/v${String(versionNo).padStart(3, "0")}-0123abcd.pdf`,
      sha256: input.sha256 ?? "a".repeat(64),
      sizeBytes: 2048,
      source: { party: input.party ?? "SUPPLIER", channel: input.channel ?? "EMAIL" },
      receivedAtSim: START_SIM,
      state: input.state ?? (input.reading === undefined ? "RECEIVED" : "READ"),
      readerAttempts: input.reading === undefined ? 0 : 1,
      ...(input.reading === undefined ? {} : { reading: input.reading, readAtSim: START_SIM }),
    },
    expectedDocumentVersion: document.version,
  });
  return version;
}

export interface TestObservation {
  readonly docType: DocType;
  readonly code: ObservationCode;
  readonly docVersionId: string;
  readonly status?: Observation["status"];
  readonly responsibleParty?: Party;
}

export async function createTestObservation(stores: MemoryStores, input: TestObservation): Promise<Observation> {
  return stores.connector.documents.createObservation({
    observationId: observationId(OPERATION, input.docType, input.code),
    operationId: OPERATION,
    clockId: CLOCK,
    docType: input.docType,
    code: input.code,
    severity: "BLOCKING",
    field: "grossWeightKg",
    expected: "12840",
    found: "12480",
    status: input.status ?? "OPEN",
    ...(input.responsibleParty === undefined ? {} : { responsibleParty: input.responsibleParty }),
    firstDocVersionId: input.docVersionId,
    lastDocVersionId: input.docVersionId,
    created: { atSim: START_SIM, atReal: REAL_NOW, by: "SYSTEM" },
  });
}
