// The synthetic documents of every operation and their ground truth (docs/seed-spec.md §8-§9): one
// structure per document version gives both the PDF's printed lines (pdf-content.ts) and the reading
// the reader mock returns for it, so the two always agree (invariant 6). Versions: v1 of each
// document; for a seeded error, the corrected next version; for `SEEDED_ERROR_TWICE`, a second
// version with the same observation before the corrected one.
import { DOC_TYPE_SHORT, DocType, operationId as opId, syntheticDocId, type ObservationCode } from "@legajo/shared";
import type { GroundTruthReading } from "@legajo/reader-mock/catalog";
import type { ReadingFields, ReadingObservation } from "@legajo/reader-contract";
import { importerSpec, supplierSpec, type ImporterSpec, type SupplierSpec } from "./catalog-parties";
import type { OperationSpec } from "./catalog-operations";
import { goodsFor, kg, type Goods } from "./goods";
import { rngFor } from "./rng";
import { addDays, arDate } from "./time";

export const ISSUING_BODY = "Synthetic Chamber of Commerce (fictitious)";

export interface Party {
  readonly name: string;
  readonly address: string;
  readonly countryName: string;
  readonly taxId?: string;
}

/** Correct content of an operation's documents, before any seeded error. */
export interface OperationTruth {
  readonly spec: OperationSpec;
  readonly operationId: string;
  readonly seller: Party;
  readonly buyer: Party & { readonly taxId: string };
  readonly goods: Goods;
  readonly invoiceDate: string;
  readonly certificateDate: string;
  readonly packingListNumber: string;
  readonly certificateNumber: string;
  readonly marks: string;
}

/** What a version prints and what the reader knows about it. */
export interface VersionContent {
  readonly invoiceNumber: string;
  readonly buyerName: string;
  readonly incoterm: string;
  readonly incotermPlace: string;
  readonly grossKg: number;
  readonly netKg: number;
  readonly packages: number;
  readonly originCountry: string;
  readonly signed: boolean;
  readonly stamped: boolean;
  readonly lowQuality: boolean;
}

export interface DocVersion {
  readonly truth: OperationTruth;
  readonly docType: DocType;
  readonly versionNo: number;
  readonly docId: string;
  readonly content: VersionContent;
  readonly reading: GroundTruthReading;
  /** Version the seeded error lives in (it has observations). */
  readonly flawed: boolean;
}

/** Invalid check digit on purpose: a CUIT-shaped number that no real taxpayer can hold. */
function fictitiousCuit(importerId: string): string {
  const rng = rngFor(`cuit:${importerId}`);
  const body = `30${rng.int(7000000, 7999999)}${rng.int(0, 9)}`;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (weights[index] ?? 0), 0);
  const valid = (11 - (sum % 11)) % 11;
  const wrong = (valid + 3) % 10;
  return `${body.slice(0, 2)}-${body.slice(2)}-${wrong}`;
}

function sellerOf(supplier: SupplierSpec): Party {
  return { name: supplier.name, address: supplier.address, countryName: supplier.countryName };
}

function buyerOf(importer: ImporterSpec): Party & { taxId: string } {
  return { name: importer.name, address: `${importer.street}, ${importer.city}, Argentina`, countryName: "Argentina", taxId: fictitiousCuit(importer.importerId) };
}

export function operationTruth(spec: OperationSpec): OperationTruth {
  const supplier = supplierSpec(spec.supplierId);
  const importer = importerSpec(spec.importerId);
  const rng = rngFor(`dates:${spec.number}`);
  const invoiceDate = spec.number === "4471" ? "2026-09-17" : addDays(arDate(spec.eta), -rng.int(26, 42));
  const goods = goodsFor(spec.number, supplier.goods, spec.number === "4471" ? { packages: 214, netPerPackage: 57, grossPerPackage: 60 } : undefined);
  const buyerWord = importer.name.split(" ")[0]?.toUpperCase() ?? "BUYER";
  return {
    spec,
    operationId: opId(spec.number),
    seller: sellerOf(supplier),
    buyer: buyerOf(importer),
    goods,
    invoiceDate,
    certificateDate: addDays(invoiceDate, 2),
    packingListNumber: `PL-${spec.invoiceNumber}`,
    certificateNumber: `SCC-2026-${String(rng.int(10000, 99999))}`,
    marks: `${buyerWord} / BUENOS AIRES / NOS. 1-${goods.packages}`,
  };
}

function correctContent(truth: OperationTruth): VersionContent {
  return {
    invoiceNumber: truth.spec.invoiceNumber,
    buyerName: truth.buyer.name,
    incoterm: truth.spec.incoterm,
    incotermPlace: truth.spec.incotermPlace,
    grossKg: truth.goods.grossKg,
    netKg: truth.goods.netKg,
    packages: truth.goods.packages,
    originCountry: truth.seller.countryName,
    signed: true,
    stamped: true,
    lowQuality: false,
  };
}

/** A weight that looks like a typo of the right one: hundreds and tens swapped (op-4471: 12,840 → 12,480). */
function transposed(value: number): number {
  const digits = String(value).split("");
  const tens = digits.length - 2;
  if (tens < 1 || digits[tens] === digits[tens - 1]) return value - 360;
  [digits[tens - 1], digits[tens]] = [digits[tens] ?? "", digits[tens - 1] ?? ""];
  return Number(digits.join(""));
}

const WRONG_INVOICE_REFS: Readonly<Record<string, readonly string[]>> = { "GEP-24-0981": ["GEP-24-0918", "GEP-2024-0981"] };

function flawedContent(truth: OperationTruth, code: ObservationCode, versionNo: number): { content: VersionContent; observation: ReadingObservation } {
  const right = correctContent(truth);
  const against = { againstDocType: "COMMERCIAL_INVOICE" };
  switch (code) {
    case "GROSS_WEIGHT_MISMATCH": {
      const found = transposed(right.grossKg);
      return { content: { ...right, grossKg: found }, observation: { code, severity: "BLOCKING", field: "grossWeightKg", expected: kg(right.grossKg), found: kg(found), ...against } };
    }
    case "NET_WEIGHT_MISMATCH": {
      const found = right.netKg - 150;
      return { content: { ...right, netKg: found }, observation: { code, severity: "BLOCKING", field: "netWeightKg", expected: kg(right.netKg), found: kg(found), ...against } };
    }
    case "PACKAGES_MISMATCH": {
      const found = right.packages - 2;
      return { content: { ...right, packages: found }, observation: { code, severity: "BLOCKING", field: "packages", expected: String(right.packages), found: String(found), ...against } };
    }
    case "INVOICE_NUMBER_MISMATCH": {
      const found = WRONG_INVOICE_REFS[right.invoiceNumber]?.[versionNo - 1] ?? `${right.invoiceNumber}-A`;
      return { content: { ...right, invoiceNumber: found }, observation: { code, severity: "BLOCKING", field: "invoiceNumber", expected: right.invoiceNumber, found, ...against } };
    }
    case "BUYER_DATA_MISMATCH": {
      const found = right.buyerName.replace(" de ", " del ").replace(/ SA$/, " SRL");
      return { content: { ...right, buyerName: found }, observation: { code, severity: "BLOCKING", field: "buyerName", expected: right.buyerName, found } };
    }
    case "INCOTERM_MISMATCH":
      return { content: { ...right, incoterm: "CFR", incotermPlace: "Buenos Aires" }, observation: { code, severity: "BLOCKING", field: "incoterm", expected: right.incoterm, found: "CFR" } };
    case "ORIGIN_MISMATCH":
      return { content: { ...right, originCountry: "China" }, observation: { code, severity: "BLOCKING", field: "originCountry", expected: right.originCountry, found: "China", ...against } };
    case "MISSING_SIGNATURE":
      return { content: { ...right, signed: false }, observation: { code, severity: "BLOCKING", field: "signed", expected: "signed", found: "not signed" } };
    case "MISSING_STAMP":
      return { content: { ...right, stamped: false }, observation: { code, severity: "BLOCKING", field: "stamped", expected: "stamped", found: "not stamped" } };
    case "LOW_CONFIDENCE":
      return { content: { ...right, lowQuality: true }, observation: { code, severity: "BLOCKING" } };
  }
}

/** Fields the reader returns for a version, by document type (invariant 6: all of them are printed). */
function fieldsOf(truth: OperationTruth, docType: DocType, content: VersionContent): ReadingFields {
  const common = { invoiceNumber: content.invoiceNumber, buyerName: content.buyerName };
  if (content.lowQuality) return { documentNumber: docType === "PACKING_LIST" ? truth.packingListNumber : content.invoiceNumber, invoiceNumber: content.invoiceNumber, issuerName: truth.seller.name };
  switch (docType) {
    case "COMMERCIAL_INVOICE":
      return { ...common, documentNumber: content.invoiceNumber, issueDate: truth.invoiceDate, issuerName: truth.seller.name, buyerTaxId: truth.buyer.taxId, incoterm: content.incoterm, currency: "USD", totalAmount: truth.goods.totalCents / 100, grossWeightKg: content.grossKg, netWeightKg: content.netKg, packages: content.packages, originCountry: content.originCountry, signed: content.signed };
    case "PACKING_LIST":
      return { ...common, documentNumber: truth.packingListNumber, issueDate: truth.invoiceDate, issuerName: truth.seller.name, grossWeightKg: content.grossKg, netWeightKg: content.netKg, packages: content.packages };
    case "CERTIFICATE_OF_ORIGIN":
      return { ...common, documentNumber: truth.certificateNumber, issueDate: truth.certificateDate, issuerName: truth.seller.name, originCountry: content.originCountry, signed: content.signed, stamped: content.stamped, issuingBody: ISSUING_BODY };
  }
}

function confidenceOf(truth: OperationTruth, docType: DocType, versionNo: number, lowQuality: boolean): number {
  if (lowQuality) return 0.41;
  return rngFor(`confidence:${truth.spec.number}:${DOC_TYPE_SHORT[docType]}:${versionNo}`).int(93, 99) / 100;
}

function version(truth: OperationTruth, docType: DocType, versionNo: number, flaw?: ObservationCode): DocVersion {
  const flawed = flaw === undefined ? { content: correctContent(truth), observation: undefined } : flawedContent(truth, flaw, versionNo);
  const reading: GroundTruthReading = {
    status: "RECOGNIZED",
    docType,
    confidence: confidenceOf(truth, docType, versionNo, flawed.content.lowQuality),
    pages: 1,
    language: "en",
    fields: fieldsOf(truth, docType, flawed.content),
    observations: flawed.observation === undefined ? [] : [flawed.observation],
  };
  return { truth, docType, versionNo, docId: syntheticDocId(truth.spec.number, docType, versionNo), content: flawed.content, reading, flawed: flaw !== undefined };
}

/** Every version with a PDF of one operation, in document and version order. */
export function operationVersions(spec: OperationSpec): DocVersion[] {
  const truth = operationTruth(spec);
  const out: DocVersion[] = [];
  for (const docType of DocType.options) {
    const error = spec.error?.docType === docType ? spec.error : undefined;
    if (error === undefined) {
      out.push(version(truth, docType, 1));
      continue;
    }
    out.push(version(truth, docType, 1, error.code));
    if (error.repeatsInV2) out.push(version(truth, docType, 2, error.code));
    out.push(version(truth, docType, error.repeatsInV2 ? 3 : 2));
  }
  return out;
}
