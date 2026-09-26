// The 30 operations of docs/seed-spec.md §7, as data: parties, vessel, ETA, invoice and incoterm,
// the state of each document at the start of the demo (M missing, V valid, O with observation) and
// the error the reader returns for version 1 (the "error sembrado") with its expected responsible.
import type { DocType, DossierStatus, MatrixResponsible, ObservationCode } from "@legajo/shared";

export type DocStateCode = "M" | "V" | "O";

export interface SeededError {
  readonly docType: DocType;
  readonly code: ObservationCode;
  /** The second version repeats the observation (`SEEDED_ERROR_TWICE`, op-4479). */
  readonly repeatsInV2?: boolean;
  /** `Reference/EVAL#`: the party that has to correct it, `SENDER` resolved (§9). */
  readonly expectedResponsible: Exclude<MatrixResponsible, "SENDER">;
}

export interface OperationSpec {
  readonly number: string;
  readonly firmId: string;
  readonly importerId: string;
  readonly supplierId: string;
  readonly vessel: string;
  /** ETA in Buenos Aires time. */
  readonly eta: string;
  readonly invoiceNumber: string;
  readonly incoterm: "FOB" | "CIF";
  readonly incotermPlace: string;
  /** Commercial invoice, packing list, certificate of origin. */
  readonly docs: readonly [DocStateCode, DocStateCode, DocStateCode];
  readonly error?: SeededError;
  readonly dossierStatus: DossierStatus;
}

const DOCS = { MMM: ["M", "M", "M"], VMM: ["V", "M", "M"], VVM: ["V", "V", "M"], VVV: ["V", "V", "V"], OMM: ["O", "M", "M"], VOM: ["V", "O", "M"] } as const;

const ar = (dayMonth: string, time: string): string => {
  const [day, month] = dayMonth.split("/");
  return `2026-${month}-${day}T${time}:00-03:00`;
};

function op(number: string, firmId: string, importerId: string, supplierId: string, vessel: string, eta: string, invoiceNumber: string, incoterm: "FOB" | "CIF", place: string, docs: keyof typeof DOCS, extra: Partial<Pick<OperationSpec, "error" | "dossierStatus">> = {}): OperationSpec {
  return { number, firmId, importerId, supplierId, vessel, eta, invoiceNumber, incoterm, incotermPlace: place, docs: DOCS[docs], dossierStatus: extra.dossierStatus ?? "OPEN", ...(extra.error === undefined ? {} : { error: extra.error }) };
}

const D = "firm-delta";
const N = "firm-norte";
const BA = "Buenos Aires";

export const OPERATIONS: readonly OperationSpec[] = [
  op("4471", D, "imp-norpampa", "sup-qingdao", "Austral Aurora", ar("22/10", "08:00"), "QBT-2026-0917", "FOB", "Qingdao", "VMM", { error: { docType: "PACKING_LIST", code: "GROSS_WEIGHT_MISMATCH", expectedResponsible: "SUPPLIER" } }),
  op("4472", D, "imp-cuyo", "sup-elbhafen", "Pacifica Horizon", ar("23/10", "07:00"), "EHT-55812", "CIF", BA, "MMM"),
  op("4473", D, "imp-litoral", "sup-shenzhen", "Pacifica Horizon", ar("23/10", "07:00"), "SZB-20931", "FOB", "Shenzhen", "MMM"),
  op("4474", D, "imp-patagonia", "sup-konkan", "Río Sur Tern", ar("24/10", "10:00"), "KCP/2026/771", "FOB", "Nhava Sheva", "MMM"),
  op("4475", D, "imp-patagonia", "sup-saigon", "Austral Meridian", ar("27/10", "06:00"), "SRF-0412", "FOB", "Ho Chi Minh City", "MMM"),
  op("4476", D, "imp-sierras", "sup-bosphorus", "Río Sur Tern", ar("26/10", "09:00"), "BKW-3318", "FOB", "Istanbul", "VMM"),
  op("4477", D, "imp-riberas", "sup-busan", "Pacifica Dawn", ar("27/10", "08:00"), "BCP-77120", "FOB", "Busan", "MMM"),
  op("4478", D, "imp-norpampa", "sup-ligurmare", "Austral Aurora", ar("19/10", "08:00"), "LVW-1190", "FOB", "Genoa", "VMM"),
  op("4479", D, "imp-cuyo", "sup-lotusmere", "Pacifica Dawn", ar("28/10", "07:00"), "GEP-24-0981", "FOB", "Guangzhou", "VVM", { error: { docType: "CERTIFICATE_OF_ORIGIN", code: "INVOICE_NUMBER_MISMATCH", repeatsInV2: true, expectedResponsible: "SUPPLIER" } }),
  op("4480", D, "imp-sierras", "sup-levante", "Austral Meridian", ar("29/10", "06:00"), "LC-2026-4410", "FOB", "Valencia", "VMM"),
  op("4481", D, "imp-riberas", "sup-ningbo", "Pacifica Horizon", ar("30/10", "07:00"), "NHL-8812", "FOB", "Ningbo", "MMM"),
  op("4482", D, "imp-patagonia", "sup-maasvlakte", "Río Sur Petrel", ar("30/10", "09:00"), "MVP-40077", "CIF", BA, "VMM"),
  op("4483", D, "imp-norpampa", "sup-santosverde", "Río Sur Petrel", ar("02/11", "09:00"), "SVA-15520", "FOB", "Santos", "MMM"),
  op("4484", D, "imp-cuyo", "sup-elbhafen", "Austral Aurora", ar("03/11", "08:00"), "EHT-55903", "CIF", BA, "OMM", { error: { docType: "COMMERCIAL_INVOICE", code: "BUYER_DATA_MISMATCH", expectedResponsible: "IMPORTER" } }),
  op("4485", D, "imp-sierras", "sup-qingdao", "Pacifica Dawn", ar("04/11", "07:00"), "QBT-2026-1002", "FOB", "Qingdao", "VOM", { error: { docType: "PACKING_LIST", code: "LOW_CONFIDENCE", expectedResponsible: "SUPPLIER" } }),
  op("4486", D, "imp-riberas", "sup-shenzhen", "Austral Meridian", ar("05/11", "06:00"), "SZB-21044", "FOB", "Shenzhen", "VVM", { error: { docType: "CERTIFICATE_OF_ORIGIN", code: "MISSING_SIGNATURE", expectedResponsible: "SUPPLIER" } }),
  op("4487", D, "imp-norpampa", "sup-shenzhen", "Pacifica Horizon", ar("16/10", "07:00"), "SZB-20870", "FOB", "Shenzhen", "VVV", { dossierStatus: "APPROVED" }),
  op("4488", D, "imp-sierras", "sup-elbhafen", "Austral Aurora", ar("21/10", "08:00"), "EHT-55790", "CIF", BA, "VVV", { dossierStatus: "READY_FOR_REVIEW", error: { docType: "PACKING_LIST", code: "PACKAGES_MISMATCH", expectedResponsible: "SUPPLIER" } }),
  op("4489", D, "imp-riberas", "sup-ningbo", "Río Sur Tern", ar("10/10", "08:00"), "NHL-8701", "FOB", "Ningbo", "VVV", { dossierStatus: "APPROVED" }),
  op("4490", D, "imp-patagonia", "sup-saigon", "Pacifica Dawn", ar("10/11", "07:00"), "SRF-0460", "FOB", "Ho Chi Minh City", "MMM"),
  op("4491", D, "imp-litoral", "sup-shenzhen", "Austral Meridian", ar("12/11", "06:00"), "SZB-21102", "FOB", "Shenzhen", "VMM"),
  op("4492", D, "imp-cuyo", "sup-lotusmere", "Río Sur Petrel", ar("14/11", "09:00"), "GEP-24-1011", "FOB", "Guangzhou", "VVM"),
  op("4493", D, "imp-sierras", "sup-bosphorus", "Pacifica Horizon", ar("17/11", "07:00"), "BKW-3390", "FOB", "Istanbul", "MMM", { error: { docType: "PACKING_LIST", code: "NET_WEIGHT_MISMATCH", expectedResponsible: "SUPPLIER" } }),
  op("4494", D, "imp-riberas", "sup-busan", "Austral Aurora", ar("20/11", "08:00"), "BCP-77301", "FOB", "Busan", "MMM", { error: { docType: "CERTIFICATE_OF_ORIGIN", code: "ORIGIN_MISMATCH", expectedResponsible: "SUPPLIER" } }),
  op("5501", N, "imp-altiplano", "sup-n-elbhafen", "Pacifica Horizon", ar("23/10", "07:00"), "EHT-56001", "CIF", BA, "VMM", { error: { docType: "PACKING_LIST", code: "GROSS_WEIGHT_MISMATCH", expectedResponsible: "SUPPLIER" } }),
  op("5502", N, "imp-quebrada", "sup-n-shenzhen", "Río Sur Tern", ar("25/10", "10:00"), "SZB-21210", "FOB", "Shenzhen", "MMM"),
  op("5503", N, "imp-altiplano", "sup-n-saigon", "Pacifica Dawn", ar("29/10", "07:00"), "SRF-0501", "FOB", "Ho Chi Minh City", "VVM", { error: { docType: "CERTIFICATE_OF_ORIGIN", code: "MISSING_STAMP", expectedResponsible: "SUPPLIER" } }),
  op("5504", N, "imp-quebrada", "sup-n-qingdao", "Austral Meridian", ar("04/11", "06:00"), "QBT-2026-1100", "FOB", "Qingdao", "MMM", { error: { docType: "COMMERCIAL_INVOICE", code: "INCOTERM_MISMATCH", expectedResponsible: "SUPPLIER" } }),
  op("5505", N, "imp-altiplano", "sup-n-elbhafen", "Austral Aurora", ar("18/10", "08:00"), "EHT-55950", "CIF", BA, "VVV", { dossierStatus: "READY_FOR_REVIEW" }),
  op("5506", N, "imp-quebrada", "sup-n-shenzhen", "Pacifica Horizon", ar("12/11", "07:00"), "SZB-21300", "FOB", "Shenzhen", "MMM"),
];

/** Carrier of each vessel (fictitious lines of §7). */
export function carrierOf(vessel: string): string {
  if (vessel.startsWith("Austral")) return "Austral Line";
  if (vessel.startsWith("Pacifica")) return "Pacifica Container Lines";
  if (vessel.startsWith("Río Sur")) return "Río Sur Shipping";
  throw new RangeError(`no carrier for ${vessel}`);
}

export function operationSpec(number: string): OperationSpec {
  const found = OPERATIONS.find((candidate) => candidate.number === number);
  if (found === undefined) throw new RangeError(`unknown operation ${number}`);
  return found;
}

/** Operations of the curated `judge` template (§3). */
export const JUDGE_OPERATIONS = ["4471", "4474", "4477", "4478", "4487", "4488"] as const;
