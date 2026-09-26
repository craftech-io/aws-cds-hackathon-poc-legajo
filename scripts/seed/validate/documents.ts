// Invariants 3-6 of docs/seed-spec.md §15, over the PDFs on disk: valid documents have a clean
// reading (or a waiver); every seeded observation is in its version's reading and has its EVAL row;
// every known PDF is in the reader's catalog by hash and by embedded id, and the unknown ones are not;
// and every field of the ground truth is printed in its PDF, whose `LegajoDocId` is the reading's.
import type { ReadingFields } from "@legajo/reader-contract";
import { GroundTruthItem } from "@legajo/reader-mock/catalog";
import { OPEN_OBSERVATION_STATUSES } from "@legajo/bff/domain/documents";
import { parseSyntheticDocId } from "@legajo/shared";
import { printedField } from "../generate/pdf-content";
import { sha256Hex } from "../lib/json";
import { pdfInfo, pdfPageCount, pdfTextLines } from "../lib/pdf";
import { str, type WorldView } from "./world-view";

type Reading = { status?: string; observations?: { code: string; severity: string }[]; fields?: ReadingFields; pages?: number; docType?: string };

/** Invariant 3: a VALID document has a clean reading of its current version, or a waiver. */
export function validDocumentProblems(view: WorldView): string[] {
  const problems: string[] = [];
  for (const doc of view.of("Document").filter((item) => item.status === "VALID")) {
    if (doc.validatedBy === "WAIVER") continue;
    const version = view.find("DocumentVersion", (item) => item.docVersionId === doc.currentDocVersionId);
    const reading = version?.reading as Reading | undefined;
    const blockingInReading = (reading?.observations ?? []).some((observation) => observation.severity === "BLOCKING");
    const openBlocking = view.of("Observation").some((observation) => observation.operationId === doc.operationId && observation.docType === doc.docType && observation.severity === "BLOCKING" && OPEN_OBSERVATION_STATUSES.includes(observation.status as never));
    if (reading?.status !== "RECOGNIZED" || blockingInReading || openBlocking) problems.push(`${view.label}: ${str(doc.operationId)} ${str(doc.docType)} is VALID without a clean reading`);
  }
  return problems;
}

/** Invariant 4: seeded observations are in their version's reading and have their EVAL row. */
export function observationProblems(view: WorldView, reference: WorldView): string[] {
  const problems: string[] = [];
  const responsibles = new Set(["SUPPLIER", "IMPORTER", "BROKER"]);
  for (const observation of view.of("Observation")) {
    const version = view.find("DocumentVersion", (item) => item.docVersionId === observation.firstDocVersionId);
    const reading = version?.reading as Reading | undefined;
    if (!(reading?.observations ?? []).some((entry) => entry.code === observation.code)) problems.push(`${view.label}: ${str(observation.observationId)} is not in the reading of ${str(observation.firstDocVersionId)}`);
    const operation = view.find("Operation", (item) => item.operationId === observation.operationId);
    const model = str(operation?.templateOperation);
    const truth = reference.find("EvalTruth", (item) => item.operationId === model && item.code === observation.code && item.docType === observation.docType);
    if (truth === undefined) problems.push(`${view.label}: ${str(observation.observationId)} has no EVAL row for ${model}`);
    else if (!responsibles.has(str(truth.expectedResponsible))) problems.push(`EVAL of ${model} names ${str(truth.expectedResponsible)}, not a responsible of the matrix`);
  }
  return problems;
}

/** Invariant 4 over the catalog: every observation a reading returns has an EVAL row. */
export function catalogEvalProblems(catalog: readonly Record<string, unknown>[], reference: WorldView): string[] {
  const problems: string[] = [];
  for (const item of catalog.filter((entry) => str(entry.PK).startsWith("DOCID#"))) {
    const parsed = parseSyntheticDocId(str(item.docId));
    for (const observation of ((item.reading as Reading | undefined)?.observations ?? [])) {
      const found = reference.find("EvalTruth", (row) => row.operationId === `op-${parsed?.operationNumber ?? ""}` && row.code === observation.code && row.docType === parsed?.docType);
      if (found === undefined) problems.push(`the reading of ${str(item.docId)} returns ${observation.code} without an EVAL row`);
    }
  }
  return problems;
}

/** Invariants 5 and 6 over every PDF on disk. */
export function catalogProblems(catalog: readonly Record<string, unknown>[], pdfs: ReadonlyMap<string, Uint8Array>): string[] {
  const problems: string[] = [];
  const bySha = new Map<string, Record<string, unknown>>();
  const byDocId = new Map<string, Record<string, unknown>>();
  for (const item of catalog) {
    const parsed = GroundTruthItem.safeParse(item);
    if (!parsed.success) {
      problems.push(`ReaderCatalog ${str(item.PK)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      continue;
    }
    if (str(item.PK).startsWith("SHA#")) bySha.set(str(item.sha256), item);
    else byDocId.set(str(item.docId), item);
  }
  for (const [path, bytes] of pdfs) {
    const sha = sha256Hex(bytes);
    const info = pdfInfo(bytes);
    if (path.startsWith("unknown/")) {
      if (bySha.has(sha) || info.LegajoDocId !== undefined) problems.push(`pdfs/${path} is unknown to the reader but has a catalog row or an embedded id`);
      continue;
    }
    const docId = info.LegajoDocId ?? "";
    const bySha256 = bySha.get(sha);
    const byId = byDocId.get(docId);
    if (bySha256 === undefined || byId === undefined) {
      problems.push(`pdfs/${path} (${docId || "no LegajoDocId"}) lacks its SHA# or DOCID# row`);
      continue;
    }
    if (str(bySha256.docId) !== docId || str(byId.sha256) !== sha) problems.push(`pdfs/${path}: catalog rows do not agree with the file`);
    const [, name = ""] = path.split("/");
    const reading = bySha256.reading as Reading;
    if (!name.startsWith(`${str(reading.docType)}-v`)) problems.push(`pdfs/${path} is read as ${str(reading.docType)}`);
    if (reading.pages !== pdfPageCount(bytes)) problems.push(`pdfs/${path}: the reading says ${String(reading.pages)} pages`);
    const text = pdfTextLines(bytes).join("\n");
    for (const [field, value] of Object.entries(reading.fields ?? {}) as [keyof ReadingFields, unknown][]) {
      if (!text.includes(printedField(field, value))) problems.push(`pdfs/${path}: ${field} "${printedField(field, value)}" of the ground truth is not printed`);
    }
  }
  return problems;
}

/** Invariant 5 from the side of the dossiers: every stored version's file is catalogued with its reading. */
export function versionCatalogProblems(view: WorldView, catalog: readonly Record<string, unknown>[]): string[] {
  const known = new Map(catalog.filter((item) => str(item.PK).startsWith("SHA#")).map((item) => [str(item.sha256), item]));
  return view
    .of("DocumentVersion")
    .filter((version) => {
      const row = known.get(str(version.sha256));
      const reading = version.reading as Reading | undefined;
      return row === undefined || JSON.stringify(reading?.fields) !== JSON.stringify((row.reading as Reading).fields) || reading?.docType !== (row.reading as Reading).docType;
    })
    .map((version) => `${view.label}: ${str(version.docVersionId)} has no catalogued file or a reading that is not the catalog's`);
}

