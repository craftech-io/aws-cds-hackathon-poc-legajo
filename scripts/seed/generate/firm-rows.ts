// Rows of the `Firms` table (docs/seed-spec.md §4, §10 and §11): each firm with its settings (every
// assumption labelled "supuesto" with its source, invariant 13), its console users, the example
// checklist written for the POC and the responsibility matrix.
import type { DocType, MatrixResponsible, ObservationCode, World } from "@legajo/shared";
import type { MatrixRule } from "@legajo/bff/domain/firms";
import { templateItem, type SeedItem } from "../lib/items";
import type { BrokerSpec, FirmSpec } from "./catalog-parties";

const LABEL = "supuesto";
const BASELINE_SOURCE = "Estimación propia del equipo (editable), no una medición";
const DELAY_SOURCE = "Fuentes secundarias no verificadas";

/** §10: example checklist of the firm; not regulation nor advice. */
export const CHECKLIST: Readonly<Record<DocType, readonly { readonly itemId: string; readonly text: string; readonly required: boolean }[]>> = {
  COMMERCIAL_INVOICE: [
    { itemId: "CI-01", text: "Número y fecha de emisión", required: true },
    { itemId: "CI-02", text: "Razón social, domicilio y país del vendedor", required: true },
    { itemId: "CI-03", text: "Razón social, CUIT y domicilio del comprador iguales a los del registro del importador en el estudio", required: true },
    { itemId: "CI-04", text: "Incoterm y lugar convenido", required: true },
    { itemId: "CI-05", text: "Moneda, cantidad, precio unitario y total de cada ítem, y total de la factura", required: true },
    { itemId: "CI-06", text: "Descripción de la mercadería suficiente para identificarla", required: true },
    { itemId: "CI-07", text: "País de origen de la mercadería", required: true },
    { itemId: "CI-08", text: "Firma del vendedor (manuscrita o digital)", required: true },
  ],
  PACKING_LIST: [
    { itemId: "PL-01", text: "Número de la factura comercial a la que corresponde", required: true },
    { itemId: "PL-02", text: "Cantidad y tipo de bultos, con marcas y números", required: true },
    { itemId: "PL-03", text: "Peso neto y bruto por bulto y totales, en kilogramos", required: true },
    { itemId: "PL-04", text: "Peso bruto total y cantidad de bultos iguales a los de la factura", required: true },
    { itemId: "PL-05", text: "Contenido de cada bulto", required: true },
  ],
  CERTIFICATE_OF_ORIGIN: [
    { itemId: "CO-01", text: "Emitido por la entidad habilitada del país exportador", required: true },
    { itemId: "CO-02", text: "Firmado y sellado por la entidad emisora", required: true },
    { itemId: "CO-03", text: "Número y fecha de la factura comercial a la que se refiere", required: true },
    { itemId: "CO-04", text: "Descripción y cantidades iguales a las de la factura", required: true },
    { itemId: "CO-05", text: "País de origen declarado", required: true },
    { itemId: "CO-06", text: "El estudio confirma en cada operación si el certificado aplica y su vigencia", required: false },
  ],
};

const rule = (docType: DocType | "ANY", code: ObservationCode, responsible: MatrixResponsible, then?: MatrixResponsible): MatrixRule => ({ docType, code, responsible, ...(then === undefined ? {} : { then }) });

/** §11 (`RESP_MATRIX#v001`): default responsible by document and observation code; the rest go to the firm. */
export const RESPONSIBILITY_MATRIX: readonly MatrixRule[] = [
  rule("ANY", "LOW_CONFIDENCE", "SENDER"),
  rule("COMMERCIAL_INVOICE", "BUYER_DATA_MISMATCH", "IMPORTER", "SUPPLIER"),
  ...(["INCOTERM_MISMATCH", "INVOICE_NUMBER_MISMATCH", "MISSING_SIGNATURE"] as const).map((code) => rule("COMMERCIAL_INVOICE", code, "SUPPLIER")),
  ...(["GROSS_WEIGHT_MISMATCH", "NET_WEIGHT_MISMATCH", "PACKAGES_MISMATCH", "INVOICE_NUMBER_MISMATCH"] as const).map((code) => rule("PACKING_LIST", code, "SUPPLIER")),
  ...(["MISSING_SIGNATURE", "MISSING_STAMP", "ORIGIN_MISMATCH", "INVOICE_NUMBER_MISMATCH"] as const).map((code) => rule("CERTIFICATE_OF_ORIGIN", code, "SUPPLIER")),
];

/** Every row of a firm; the rows of a guest's own firm carry that world's stamp (`world: "guest"`). */
export function firmRows(firm: FirmSpec, brokers: readonly BrokerSpec[], world?: World): SeedItem[] {
  const rows: SeedItem[] = [
    templateItem("Firm", {
      firmId: firm.firmId,
      name: firm.name,
      kind: firm.kind,
      mailboxAddress: firm.mailboxAddress,
      businessHours: { timezone: "America/Argentina/Buenos_Aires", from: "09:00", to: "18:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"] },
      ...(firm.clockId === undefined ? {} : { clockId: firm.clockId }),
      active: true,
    }),
    templateItem("FirmSettings", {
      firmId: firm.firmId,
      manualBaseline: {
        items: [
          { action: "Contactos por legajo", count: 8, minutes: 8, label: LABEL },
          { action: "Revisión de documentos", count: 3, minutes: 7, label: LABEL },
          { action: "Armado del legajo", count: 1, minutes: 10, label: LABEL },
        ],
        source: BASELINE_SOURCE,
        label: LABEL,
      },
      humanActionMinutes: {
        items: (
          [
            ["TAKE", 2],
            ["SEND", 3],
            ["WAIVE", 4],
            ["CLASSIFY", 4],
            ["APPROVE", 10],
            ["REOPEN", 5],
          ] as const
        ).map(([action, minutes]) => ({ action, minutes, label: LABEL })),
        source: BASELINE_SOURCE,
        label: LABEL,
      },
      assumptions: { freeDaysAtPort: 5, demurrageUsdPerDay: { min: 160, max: 180 }, source: DELAY_SOURCE, label: LABEL },
      costBudgetUsdPerDossier: 2,
      turnCaps: firm.turnCaps,
      untrustedSenderEmailsPerDay: 3,
    }),
    ...brokers.map((broker) => templateItem("Broker", { brokerId: broker.brokerId, firmId: firm.firmId, name: broker.name, role: broker.role, cognitoSub: "", active: true })),
    ...(Object.keys(CHECKLIST) as DocType[]).map((docType) => templateItem("Checklist", { firmId: firm.firmId, docType, checklistVersion: 1, items: CHECKLIST[docType].map((item) => ({ ...item, docType })) })),
    templateItem("ResponsibilityMatrix", { firmId: firm.firmId, matrixVersion: 1, rules: RESPONSIBILITY_MATRIX, fallback: "BROKER" }),
  ];
  return world === undefined ? rows : rows.map((row) => ({ ...row, world }));
}
