// Labels of the reader's observation codes (`Reference/OBS_CODE`, docs/seed-spec.md §12), in Spanish
// for the importer and the console and in English for the supplier. The code comes from the reader;
// we never reinterpret a document (ADR-0003), we only name what the reader found.
import type { DocType, ObservationCode } from "@legajo/shared";
import { docTypeOfEsAR } from "./es-AR";
import type { ObservationLabels } from "./types";

export const OBSERVATION_LABELS: ObservationLabels = {
  GROSS_WEIGHT_MISMATCH: {
    es: "peso bruto distinto del de la factura",
    en: "gross weight does not match the commercial invoice",
    esField: "el peso bruto",
    enSubject: "gross weight",
  },
  NET_WEIGHT_MISMATCH: {
    es: "peso neto distinto del de la factura",
    en: "net weight does not match the commercial invoice",
    esField: "el peso neto",
    enSubject: "net weight",
  },
  INVOICE_NUMBER_MISMATCH: {
    es: "número de factura distinto del de la factura comercial",
    en: "invoice number does not match the commercial invoice",
    esField: "el número de factura",
    enSubject: "invoice number",
  },
  INCOTERM_MISMATCH: {
    es: "incoterm distinto del de la operación",
    en: "incoterm does not match the operation",
    esField: "el incoterm",
    enSubject: "incoterm",
  },
  BUYER_DATA_MISMATCH: {
    es: "datos del comprador distintos del registro del importador",
    en: "buyer details do not match the importer's records",
    esField: "los datos del comprador",
    enSubject: "buyer details",
  },
  ORIGIN_MISMATCH: {
    es: "país de origen distinto del de la factura",
    en: "country of origin does not match the commercial invoice",
    esField: "el país de origen",
    enSubject: "country of origin",
  },
  PACKAGES_MISMATCH: {
    es: "cantidad de bultos distinta de la de la factura",
    en: "number of packages does not match the commercial invoice",
    esField: "la cantidad de bultos",
    enSubject: "number of packages",
  },
  MISSING_SIGNATURE: {
    es: "falta la firma",
    en: "signature missing",
    esField: "la firma",
    enSubject: "signature",
  },
  MISSING_STAMP: {
    es: "falta el sello",
    en: "stamp missing",
    esField: "el sello",
    enSubject: "stamp",
  },
  LOW_CONFIDENCE: {
    es: "copia ilegible",
    en: "copy not legible",
    esField: "la legibilidad",
    enSubject: "legibility",
  },
};

/** "el peso bruto del packing list": parameter of `legajo_observacion_proveedor`. */
export function correctionTargetEsAR(code: ObservationCode, docType: DocType): string {
  return `${OBSERVATION_LABELS[code].esField} ${docTypeOfEsAR[docType]}`;
}
