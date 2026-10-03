// The scripted agent (docs/seed-spec.md §13, "Agente guionado"): one fixed plan per kind of turn, the
// same for every operation, whose steps depend only on what the turn's own tools answered. It is what
// the metrics batch and the tour's timeline run in place of the model: the policy, the matrix, the
// milestones and the outbound verification around it are the stage's own.
//
//   MILESTONE DOCS_REQUEST         the importer's template, and the first request to the supplier
//   MILESTONE FOLLOWUP(_FINAL)     a reminder in the supplier's thread while documents are missing
//   SUPPLIER_EMAIL, DOCUMENT_READ  complete dossier → request_approval; an open observation → the matrix's
//                                  responsible, and a correction request to the supplier when it is theirs
//   EMAIL_BOUNCED                  the importer is asked for another contact (legajo_contacto_proveedor)
//   ETA_CHANGED                    the importer gets the new deadline (legajo_nuevo_plazo)
//   anything else                  a note only
import { DOCS_REQUEST_PLAN, EMAIL_DOCS_REQUEST, EMAIL_REMINDER, READ_DOSSIER, READ_OPERATION, READ_SUPPLIER, assign, correctionEmail, field, outputOf } from "./plans";
import { QUIET_PLAN, type Plan, type PlanContext, type PlanSource, type PlanStep } from "./scripted-harness";

interface DossierView {
  readonly complete?: boolean;
  readonly missing?: readonly string[];
  readonly documents?: ReadonlyArray<{ readonly docType: string; readonly observations: ReadonlyArray<{ readonly status: string; readonly responsibleParty?: string }> }>;
}

const dossierOf = (context: PlanContext): DossierView => outputOf(context.calls, "get_dossier") as DossierView;
const isMissing = (context: PlanContext) => (dossierOf(context).missing ?? []).length > 0;

/** The first document with an open observation, if any. */
function observed(context: PlanContext): string | undefined {
  return dossierOf(context).documents?.find((document) => document.observations.some((observation) => observation.status === "OPEN"))?.docType;
}

const ENGLISH: Readonly<Record<string, string>> = { COMMERCIAL_INVOICE: "commercial invoice", PACKING_LIST: "packing list", CERTIFICATE_OF_ORIGIN: "certificate of origin" };

/** Steps for one document type, taken only when that document is the observed one. */
function observationSteps(docType: string): PlanStep[] {
  const isIt = (context: PlanContext) => observed(context) === docType;
  return [
    { ...assign(docType, "SUPPLIER", "La matriz del estudio asigna esta observación al proveedor."), when: isIt },
    { ...correctionEmail(docType, ENGLISH[docType] ?? docType), when: isIt },
  ];
}

const READING: Plan = {
  steps: [
    READ_OPERATION,
    READ_DOSSIER,
    { tool: "request_approval", input: { summary: "Los documentos están completos y sin observaciones abiertas." }, when: (context) => dossierOf(context).complete === true },
    ...Object.keys(ENGLISH).flatMap(observationSteps),
  ],
  note: "Revisé lo que llegó.",
};

const FIRST_REQUEST: Plan = { ...DOCS_REQUEST_PLAN, steps: [...DOCS_REQUEST_PLAN.steps, { ...EMAIL_DOCS_REQUEST, when: isMissing }], note: "Pedí los documentos al importador y al proveedor." };

const FOLLOWUP: Plan = { steps: [READ_OPERATION, READ_DOSSIER, { ...EMAIL_REMINDER, when: isMissing }], note: "Recordé lo que falta." };

const BOUNCED: Plan = {
  steps: [
    READ_OPERATION,
    READ_SUPPLIER,
    {
      tool: "send_whatsapp",
      input: (context) => ({
        recipientRole: "IMPORTER",
        kind: "CONTACT_REQUEST",
        template: { name: "legajo_contacto_proveedor", params: [field(context.calls, "get_operation", "operation", "operationNumber"), field(context.calls, "get_operation", "operation", "supplier", "name")] },
      }),
    },
  ],
  note: "Pedí otro contacto del proveedor.",
};

const ETA_CHANGED: Plan = {
  steps: [
    READ_OPERATION,
    READ_DOSSIER,
    {
      tool: "send_whatsapp",
      input: (context) => ({
        recipientRole: "IMPORTER",
        kind: "ETA_CHANGE",
        template: { name: "legajo_nuevo_plazo", params: [field(context.calls, "get_operation", "operation", "operationNumber"), field(context.calls, "get_operation", "operation", "etaText"), field(context.calls, "get_dossier", "deadlines", "importer", "text")] },
      }),
    },
  ],
  note: "Avisé el nuevo plazo.",
};

/** The milestone a `MILESTONE` turn is about, from the envelope's facts. */
function milestoneOf(text: string): string | undefined {
  return /^milestone name="([A-Z_]+)"/m.exec(text)?.[1];
}

/** The scripted agent: a plan for every turn of any operation. */
export const scriptedAgent: PlanSource = (envelope) => {
  switch (envelope.event.type) {
    case "MILESTONE": {
      const milestone = milestoneOf(envelope.text);
      if (milestone === "DOCS_REQUEST") return FIRST_REQUEST;
      if (milestone === "FOLLOWUP" || milestone === "FOLLOWUP_FINAL") return FOLLOWUP;
      return QUIET_PLAN;
    }
    case "SUPPLIER_EMAIL":
    case "DOCUMENT_READ":
    case "UPLOAD_COMPLETED":
      return READING;
    case "EMAIL_BOUNCED":
      return BOUNCED;
    case "ETA_CHANGED":
      return ETA_CHANGED;
    default:
      return QUIET_PLAN;
  }
};
