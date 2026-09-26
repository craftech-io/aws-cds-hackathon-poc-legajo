// What the supplier reads, in English, and the English words for the enums (also used by the gloss).
// The body of an email to the supplier is written by the agent (checked by G2 and the deterministic
// verification); the code builds everything around it from here: sender name and subject
// (docs/architecture-integrations.md §1).
import type { DocType, ObservationCode, SupplierEmailKind } from "@legajo/shared";
import { PRODUCT_NAME, joinList } from "./helpers";
import { OBSERVATION_LABELS } from "./observation-labels";
import type { Labels } from "./types";

export const labelsEn: Labels = {
  docType: {
    COMMERCIAL_INVOICE: "commercial invoice",
    PACKING_LIST: "packing list",
    CERTIFICATE_OF_ORIGIN: "certificate of origin",
  },
  docStatus: {
    MISSING: "missing",
    RECEIVED: "received",
    WITH_OBSERVATION: "with observation",
    VALID: "valid",
  },
  dossierStatus: {
    OPEN: "open",
    READY_FOR_REVIEW: "ready for review",
    APPROVED: "approved",
    REOPENED: "reopened",
  },
  party: {
    IMPORTER: "importer",
    SUPPLIER: "supplier",
    BROKER: "firm",
  },
  channel: {
    WHATSAPP: "WhatsApp",
    EMAIL: "email",
  },
  messageKind: {
    DOCS_REQUEST: "documents request",
    REMINDER: "reminder",
    CORRECTION_REQUEST: "correction request",
    NO_ACTION_NEEDED: "nothing-to-do notice",
    CONTACT_REQUEST: "request for another contact",
    CONTACT_CONFIRMATION: "contact confirmation",
    UPLOAD_LINK: "upload link",
    ETA_CHANGE: "estimated arrival change",
    ESCALATION_NOTICE: "handover-to-the-firm notice",
    ESCALATION: "escalation",
    APPROVAL_NOTICE: "approval notice",
    DISPATCH_STATUS: "dispatch status",
    REPLY: "reply",
    BROKER_MESSAGE: "message from the firm",
    OPT_OUT_CONFIRMATION: "opt-out confirmation",
    OPERATION_CHOICE: "operation choice",
  },
  escalationReason: {
    MISSING_AT_ETA_48H: "documents missing 48 h before arrival",
    OBSERVATION_ATTEMPTS: "a correction came back with the same observation",
    OUT_OF_CHECKLIST: "question outside the checklist",
    IMPORTER_ASKED: "the importer asked to talk to a person",
    UNRECOGNIZED_DOCUMENT: "document the reader does not recognize",
    NO_VALID_CONTACT: "supplier without a valid contact",
    UNTRUSTED_SENDER: "email from an untrusted sender",
    OPTED_OUT: "the importer asked not to receive notices",
    READER_UNAVAILABLE: "document reader unavailable",
    OTHER: "other reason",
  },
};

/** Documents of a subject, in `DocType` order: "packing list, certificate of origin". */
export function documentListEn(docTypes: readonly DocType[]): string {
  return docTypes.map((docType) => labelsEn.docType[docType]).join(", ");
}

/** "packing list and certificate of origin": documents inside an English sentence. */
export function documentSentenceEn(docTypes: readonly DocType[]): string {
  return joinList(
    docTypes.map((docType) => labelsEn.docType[docType]),
    "and",
  );
}

export interface SupplierSubjectParams {
  readonly operationNumber: string;
  readonly invoiceNumber: string;
  /** Documents the email is about (`refs.docTypes`). */
  readonly docTypes: readonly DocType[];
  /** The observation of a `CORRECTION_REQUEST` (`refs.observationIds`, resolved by the code). */
  readonly observation?: { readonly code: ObservationCode; readonly docType: DocType };
  /** Subject of the last message of the thread, for a `REPLY`. */
  readonly threadSubject?: string;
}

/** "Re: <subject>", without stacking a second "Re:". */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

function opTag(operationNumber: string): string {
  return `[Op ${operationNumber}]`;
}

const SUBJECTS: Readonly<Record<SupplierEmailKind, (params: SupplierSubjectParams) => string>> = {
  DOCS_REQUEST: (p) => `${opTag(p.operationNumber)} Missing documents: ${documentListEn(p.docTypes)} (Invoice ${p.invoiceNumber})`,
  REMINDER: (p) => `${opTag(p.operationNumber)} Reminder: ${documentListEn(p.docTypes)} still missing (Invoice ${p.invoiceNumber})`,
  CORRECTION_REQUEST: (p) => {
    if (!p.observation) throw new RangeError("a correction subject needs the observation");
    const { code, docType } = p.observation;
    return `${opTag(p.operationNumber)} Correction needed: ${labelsEn.docType[docType]} ${OBSERVATION_LABELS[code].enSubject}`;
  },
  ETA_CHANGE: (p) => `${opTag(p.operationNumber)} Estimated arrival changed: new deadline (Invoice ${p.invoiceNumber})`,
  REPLY: (p) => replySubject(p.threadSubject ?? `${opTag(p.operationNumber)} Invoice ${p.invoiceNumber}`),
};

export const supplierEmailEn = {
  /** Visible name of the `From` and `Reply-To` (the thread address): the firm, via the product. */
  displayName: (firmName: string): string => `${firmName} via ${PRODUCT_NAME}`,
  subject: (kind: SupplierEmailKind, params: SupplierSubjectParams): string => SUBJECTS[kind](params),
};
