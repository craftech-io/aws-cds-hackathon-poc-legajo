// What each synthetic PDF prints (docs/seed-spec.md §8): English, as an exporter would issue it, with
// the synthetic watermark on every page and the document id in the footer. The printed values come
// from the same `VersionContent` as the reader's ground truth; `printedField` is the one formatter
// both the PDF and the validator's invariant 6 use.
import type { ReadingFields } from "@legajo/reader-contract";
import { INJECTION_PDF_TITLE } from "@legajo/bff/copy/en-supplier-sim";
import type { PdfDocumentSpec, PdfLine } from "../lib/pdf";
import { GENERATOR_VERSION } from "../lib/constants";
import { ISSUING_BODY, type DocVersion } from "./documents";
import { enInt, enMoney, kg } from "./goods";

export const WATERMARK = "SYNTHETIC — NOT A REAL DOCUMENT";
export const PRODUCER = `Legajo listo seed generator ${GENERATOR_VERSION}`;

/** How a reading field is printed in the PDF (invariant 6 looks for exactly this text). */
export function printedField(field: keyof ReadingFields, value: unknown): string {
  switch (field) {
    case "grossWeightKg":
    case "netWeightKg":
      return kg(Number(value));
    case "totalAmount":
      return `USD ${enMoney(Math.round(Number(value) * 100))}`;
    case "packages":
      return enInt(Number(value));
    case "signed":
      return value === true ? "signed" : "not signed";
    case "stamped":
      return value === true ? "stamped" : "not stamped";
    default:
      return String(value);
  }
}

const title = (text: string): PdfLine => ({ text, size: 16, bold: true });
const heading = (text: string): PdfLine => ({ text, bold: true, gapBefore: 8 });
const line = (text: string, indent = 0): PdfLine => ({ text, indent });

/** A low-quality scan prints its numbers as `#`: the reader cannot read them either. */
function blur(text: string, lowQuality: boolean): string {
  return lowQuality ? text.replace(/[0-9]/g, "#") : text;
}

function invoiceLines(version: DocVersion): PdfLine[] {
  const { truth, content } = version;
  const { goods } = truth;
  return [
    title("COMMERCIAL INVOICE"),
    line(`Invoice No.: ${content.invoiceNumber}`),
    line(`Date: ${truth.invoiceDate}`),
    heading("Seller"),
    line(truth.seller.name, 12),
    line(truth.seller.address, 12),
    line(`Country: ${truth.seller.countryName}`, 12),
    heading("Buyer"),
    line(content.buyerName, 12),
    line(`CUIT (fictitious): ${truth.buyer.taxId}`, 12),
    line(truth.buyer.address, 12),
    heading("Terms"),
    line(`Incoterm: ${content.incoterm} ${content.incotermPlace}`, 12),
    line("Currency: USD", 12),
    heading("Items"),
    ...goods.lines.map((item, index) => line(`${index + 1}. ${item.description} · Qty: ${enInt(item.quantity)} ${item.unit} · Unit price: USD ${enMoney(item.unitPriceCents)} · Total: USD ${enMoney(item.totalCents)}`, 12)),
    heading(`Invoice total: ${printedField("totalAmount", goods.totalCents / 100)}`),
    line(`Country of origin: ${content.originCountry}`),
    line(`Total gross weight: ${kg(content.grossKg)}`),
    line(`Total net weight: ${kg(content.netKg)}`),
    line(`Packages: ${printedField("packages", content.packages)} ${goods.packageType}`),
    line(`Seller's signature: ${printedField("signed", content.signed)}`, 0),
  ];
}

function packingListLines(version: DocVersion): PdfLine[] {
  const { truth, content } = version;
  const { goods } = truth;
  const q = (text: string) => blur(text, content.lowQuality);
  return [
    title("PACKING LIST"),
    line(`Packing list No.: ${truth.packingListNumber}`),
    line(q(`Date: ${truth.invoiceDate}`)),
    line(`Commercial invoice No.: ${content.invoiceNumber}`),
    line(`Shipper: ${truth.seller.name}`),
    line(q(`Consignee: ${content.buyerName}`)),
    line(q(`Marks: ${truth.marks}`)),
    ...(content.lowQuality ? [line("Scan quality: low. Parts of this copy cannot be read.")] : []),
    heading("Contents"),
    ...goods.lines.map((item, index) =>
      line(q(`${index + 1}. ${enInt(item.packages)} ${goods.packageType} · ${item.description} · ${enInt(item.perPackage)} ${item.unit} per package · net ${kg(goods.netPerPackage)} / gross ${kg(goods.grossPerPackage)} per package`), 12),
    ),
    heading("Totals"),
    line(q(`Total packages: ${printedField("packages", content.packages)} ${goods.packageType}`)),
    line(q(`Total net weight: ${kg(content.netKg)}`)),
    line(q(`Total gross weight: ${kg(content.grossKg)}`)),
  ];
}

function certificateLines(version: DocVersion): PdfLine[] {
  const { truth, content } = version;
  return [
    title("CERTIFICATE OF ORIGIN"),
    line(`Issued by: ${ISSUING_BODY}`),
    line(`Certificate No.: ${truth.certificateNumber}`),
    line(`Date: ${truth.certificateDate}`),
    heading("Exporter"),
    line(truth.seller.name, 12),
    line(truth.seller.address, 12),
    heading("Importer"),
    line(content.buyerName, 12),
    line(truth.buyer.address, 12),
    line(`Commercial invoice No.: ${content.invoiceNumber}`),
    heading("Goods"),
    ...truth.goods.lines.map((item, index) => line(`${index + 1}. ${item.description} · ${enInt(item.quantity)} ${item.unit}`, 12)),
    line(`Country of origin: ${content.originCountry}`, 0),
    heading("Issuing body"),
    line(`Signature: ${printedField("signed", content.signed)}`, 12),
    line(`Stamp: ${printedField("stamped", content.stamped)}`, 12),
  ];
}

/** Operation whose supplier behaves `INJECTION`: its PDFs carry a hostile `Title` (FL-038). */
export const INJECTION_OPERATION = "4483";

export function versionPdf(version: DocVersion): PdfDocumentSpec {
  const lines = version.docType === "COMMERCIAL_INVOICE" ? invoiceLines(version) : version.docType === "PACKING_LIST" ? packingListLines(version) : certificateLines(version);
  const injected = version.truth.spec.number === INJECTION_OPERATION;
  return {
    info: {
      Title: injected ? INJECTION_PDF_TITLE : `Synthetic ${version.docType.toLowerCase().replaceAll("_", " ")} ${version.truth.spec.invoiceNumber}`,
      Producer: PRODUCER,
      LegajoDocId: version.docId,
    },
    lines,
    watermark: WATERMARK,
    footer: `Synthetic document · Doc ID: ${version.docId}`,
  };
}

const UNKNOWN_DOCUMENTS: readonly { readonly title: string; readonly lines: readonly string[] }[] = [
  { title: "PRODUCT CATALOGUE", lines: ["Seasonal collection overview", "Models, colours and packaging options", "Prices on request"] },
  { title: "QUALITY INSPECTION NOTE", lines: ["Visual inspection of a production sample", "Result: accepted", "Inspector: internal quality team"] },
  { title: "WAREHOUSE RECEIPT", lines: ["Goods received at the origin warehouse", "Storage position: row 4, bay 12", "Pending shipping instructions"] },
];

/** The three PDFs the reader does not know (`pdfs/unknown/`): no `LegajoDocId`, not in the catalog. */
export function unknownPdfs(): PdfDocumentSpec[] {
  return UNKNOWN_DOCUMENTS.map((document, index) => ({
    info: { Title: `Synthetic ${document.title.toLowerCase()}`, Producer: PRODUCER },
    lines: [title(document.title), ...document.lines.map((text) => line(text))],
    watermark: WATERMARK,
    footer: `Synthetic document · not part of any dossier · unknown-${index + 1}`,
  }));
}
