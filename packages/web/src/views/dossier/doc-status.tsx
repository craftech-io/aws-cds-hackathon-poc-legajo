// The state of a dossier's documents at a glance: one badge per document, or the strip of three
// marks the list of operations shows (faltante / recibido / con observación / válido). Each mark is
// read out as "Packing list: con observación", never as a colour alone.
import type { DocStatus, DocType } from "@legajo/shared";
import { Badge } from "../../components/Badge";
import { localized, type Widen } from "../../copy/localized";
import { DOC_TYPE_ORDER, docStatusLabel, docStatusTone, docTypeLabel } from "./labels";

const SHORT_ES = {
  COMMERCIAL_INVOICE: "FC",
  PACKING_LIST: "PL",
  CERTIFICATE_OF_ORIGIN: "CO",
} satisfies Record<DocType, string>;

/** The marks of the strip: initials of each document in the console's language. */
const SHORT: Readonly<Record<DocType, string>> = localized({
  es: SHORT_ES,
  en: { COMMERCIAL_INVOICE: "CI", PACKING_LIST: "PL", CERTIFICATE_OF_ORIGIN: "CO" } satisfies Widen<typeof SHORT_ES>,
});

const MARK: Readonly<Record<DocStatus, string>> = {
  MISSING: "border-mist bg-white text-slate",
  RECEIVED: "border-info bg-info-soft text-info",
  WITH_OBSERVATION: "border-warning bg-warning-soft text-warning",
  VALID: "border-success bg-success-soft text-success",
};

export function DocStatusBadge({ status }: { readonly status: DocStatus }) {
  return <Badge tone={docStatusTone[status]}>{docStatusLabel[status]}</Badge>;
}

function docStatusText(docType: DocType, status: DocStatus): string {
  return `${docTypeLabel[docType]}: ${docStatusLabel[status].toLowerCase()}`;
}

interface StripProps {
  readonly documents: readonly { readonly docType: DocType; readonly status: DocStatus }[];
}

/** Three marks in the order of the dossier (invoice, packing list, certificate). */
export function DocStatusStrip({ documents }: StripProps) {
  const byType = new Map(documents.map((document) => [document.docType, document.status]));
  return (
    <ul className="flex gap-1">
      {DOC_TYPE_ORDER.map((docType) => {
        const status = byType.get(docType) ?? "MISSING";
        const text = docStatusText(docType, status);
        return (
          <li key={docType} title={text} className={`rounded border px-1.5 py-0.5 font-mono text-xs font-semibold ${MARK[status]}`}>
            <span aria-hidden="true">{SHORT[docType]}</span>
            <span className="sr-only">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}
