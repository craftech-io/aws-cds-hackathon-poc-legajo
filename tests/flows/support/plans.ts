// Scripted plans the local flows share: the calls a model would make for a turn, written once. Inputs
// that depend on what an earlier call of the same turn answered are functions of the turn's calls, so a
// parameter is always copied from a tool result (the outbound pipeline's grounding checks it).
import type { GatewayCall } from "./gateway";
import type { Plan, PlanContext, PlanStep } from "./scripted-harness";

/** What `tool` answered earlier in this turn (its first call). */
export function outputOf(calls: readonly GatewayCall[], tool: string): Record<string, unknown> {
  const call = calls.find((candidate) => candidate.tool === tool);
  if (call === undefined) throw new Error(`the plan reads ${tool} before calling it`);
  return (call.output ?? {}) as Record<string, unknown>;
}

/** A nested field of an earlier result, e.g. `field(calls, "get_operation", "operation", "vessel")`. */
export function field(calls: readonly GatewayCall[], tool: string, ...path: string[]): string {
  let value: unknown = outputOf(calls, tool);
  for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== "string") throw new Error(`${tool}.${path.join(".")} is not a string in this turn's result`);
  return value;
}

export const READ_OPERATION: PlanStep = { tool: "get_operation", input: {} };
export const READ_DOSSIER: PlanStep = { tool: "get_dossier", input: {} };
export const READ_IMPORTER: PlanStep = { tool: "get_counterpart_profile", input: { party: "IMPORTER" } };
export const READ_SUPPLIER: PlanStep = { tool: "get_counterpart_profile", input: { party: "SUPPLIER" } };

/** The missing documents of `get_dossier`, as the template's last parameter writes them. */
export function missingText(context: PlanContext): string {
  const dossier = outputOf(context.calls, "get_dossier") as { missing?: string[]; documents?: Array<{ docType: string; label: string }> };
  const labels = (dossier.missing ?? []).map((docType) => dossier.documents?.find((document) => document.docType === docType)?.label ?? docType);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} y ${labels.at(-1) ?? ""}`;
}

/** `legajo_docs_pendientes` with every parameter copied from this turn's results (FL-007). */
export const SEND_DOCS_REQUEST: PlanStep = {
  tool: "send_whatsapp",
  input: (context) => ({
    recipientRole: "IMPORTER",
    kind: "DOCS_REQUEST",
    template: {
      name: "legajo_docs_pendientes",
      params: [field(context.calls, "get_operation", "operation", "firmName"), field(context.calls, "get_operation", "operation", "operationNumber"), field(context.calls, "get_operation", "operation", "vessel"), field(context.calls, "get_operation", "operation", "etaText"), missingText(context)],
    },
    refs: { docTypes: (outputOf(context.calls, "get_dossier").missing as string[] | undefined) ?? [] },
  }),
};

/** The `MILESTONE DOCS_REQUEST` turn of the main story (FL-007). */
export const DOCS_REQUEST_PLAN: Plan = { steps: [READ_OPERATION, READ_DOSSIER, READ_IMPORTER, SEND_DOCS_REQUEST], note: "Pedí los documentos al importador con la plantilla." };

/** One free-text WhatsApp to the importer inside the 24-hour window. */
export function reply(kind: string, text: string | ((context: PlanContext) => string), extra: Readonly<Record<string, unknown>> = {}): PlanStep {
  return { tool: "send_whatsapp", input: (context) => ({ recipientRole: "IMPORTER", kind, text: typeof text === "string" ? text : text(context), ...extra }) };
}

export function escalate(reason: "OUT_OF_CHECKLIST" | "IMPORTER_ASKED" | "OTHER", summary: string, notifyImporter?: boolean): PlanStep {
  return { tool: "escalate_to_broker", input: { reason, summary, ...(notifyImporter === undefined ? {} : { notifyImporter }) } };
}

/** The three buttons of a `CONTACT_CONFIRMATION`; the code binds the first two to the ACTIVE contact (FL-011). */
export const CONTACT_BUTTONS = [{ action: "CONFIRM_CONTACT" }, { action: "REJECT_CONTACT" }, { action: "OTHER_CONTACT" }] as const;

/** "¿Le escribimos a s***@…?" with the masked ACTIVE contact `get_counterpart_profile(SUPPLIER)` returned (FL-011). */
export const CONTACT_CONFIRMATION: PlanStep = reply(
  "CONTACT_CONFIRMATION",
  (context) => {
    const supplier = outputOf(context.calls, "get_counterpart_profile").supplier as { contacts?: Array<{ emailMasked: string; status: string }> } | undefined;
    const active = supplier?.contacts?.find((contact) => contact.status === "ACTIVE");
    return `¿Le escribimos a ${active?.emailMasked ?? ""} para pedirle los documentos?`;
  },
  { buttons: CONTACT_BUTTONS },
);

const ENGLISH_NAMES: Readonly<Record<string, string>> = { COMMERCIAL_INVOICE: "commercial invoice", PACKING_LIST: "packing list", CERTIFICATE_OF_ORIGIN: "certificate of origin" };

/** The missing documents of `get_dossier`, in English. */
export function missingEnglish(context: PlanContext): string {
  const names = ((outputOf(context.calls, "get_dossier").missing as string[] | undefined) ?? []).map((docType) => ENGLISH_NAMES[docType] ?? docType);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** An email to the supplier's ACTIVE contact whose figures come from `get_operation` and `get_dossier` of this turn. */
export function supplierEmail(kind: string, body: (context: PlanContext) => string): PlanStep {
  return {
    tool: "send_email",
    input: (context) => ({ recipientRole: "SUPPLIER", kind, text: body(context), refs: { docTypes: (outputOf(context.calls, "get_dossier").missing as string[] | undefined) ?? [] } }),
  };
}

/** The first request in English: what is missing, the invoice and Incoterm to match, the supplier's deadline in its zone (FL-012). */
export const EMAIL_DOCS_REQUEST: PlanStep = supplierEmail(
  "DOCS_REQUEST",
  (context) =>
    `Hello,\n\nWe are writing on behalf of ${field(context.calls, "get_operation", "operation", "firmName")} about invoice ${field(context.calls, "get_operation", "operation", "invoiceNumber")} (${field(context.calls, "get_operation", "operation", "incoterm")}). We still need the ${missingEnglish(context)}, matching that invoice. Please send them by ${field(context.calls, "get_dossier", "deadlines", "supplier", "text")}.\n\nThank you.`,
);

/** A reminder in the thread about what is still missing (FL-025, FL-028). */
export const EMAIL_REMINDER: PlanStep = supplierEmail(
  "REMINDER",
  (context) =>
    `Hello,\n\nThis is a reminder about invoice ${field(context.calls, "get_operation", "operation", "invoiceNumber")}: the ${missingEnglish(context)} ${missingEnglish(context).includes(" and ") ? "are" : "is"} still missing. Please send ${missingEnglish(context).includes(" and ") ? "them" : "it"} by ${field(context.calls, "get_dossier", "deadlines", "supplier", "text")}.\n\nThank you.`,
);

interface DossierObservation {
  readonly observationId: string;
  readonly code: string;
  readonly expected?: string;
  readonly found?: string;
  readonly status: string;
}

/** The open observation of `docType` that `get_dossier` returned in this turn. */
export function observationOf(context: PlanContext, docType: string): DossierObservation {
  const documents = (outputOf(context.calls, "get_dossier").documents ?? []) as Array<{ docType: string; observations: DossierObservation[] }>;
  const observation = documents.find((document) => document.docType === docType)?.observations.find((candidate) => candidate.status !== "RESOLVED");
  if (observation === undefined) throw new Error(`get_dossier returned no open observation of ${docType}`);
  return observation;
}

/** `assign_responsible` of the open observation of `docType`. */
export function assign(docType: string, responsibleParty: "SUPPLIER" | "IMPORTER" | "BROKER", rationale = "Lo corrige quien emitió el documento."): PlanStep {
  return { tool: "assign_responsible", input: (context) => ({ observationId: observationOf(context, docType).observationId, responsibleParty, rationale }) };
}

/** The correction request to the supplier: what was found, what the invoice says, and the deadline (FL-022). */
export function correctionEmail(docType: string, what: string): PlanStep {
  return {
    tool: "send_email",
    input: (context) => {
      const observation = observationOf(context, docType);
      return {
        recipientRole: "SUPPLIER",
        kind: "CORRECTION_REQUEST",
        text: `Hello,\n\nThe ${what} you sent for invoice ${field(context.calls, "get_operation", "operation", "invoiceNumber")} shows ${observation.found ?? ""} where ${observation.expected ?? ""} is expected. Please send a corrected ${what} by ${field(context.calls, "get_dossier", "deadlines", "supplier", "text")}.\n\nThank you.`,
        refs: { docTypes: [docType], observationIds: [observation.observationId] },
      };
    },
  };
}

/** `legajo_observacion_proveedor`: the supplier corrects it, the importer does nothing (FL-022, FL-041). */
export function noActionNeeded(docType: string): PlanStep {
  return {
    tool: "send_whatsapp",
    input: (context) => {
      const documents = (outputOf(context.calls, "get_dossier").documents ?? []) as Array<{ docType: string; label: string }>;
      return {
        recipientRole: "IMPORTER",
        kind: "NO_ACTION_NEEDED",
        template: { name: "legajo_observacion_proveedor", params: [field(context.calls, "get_operation", "operation", "operationNumber"), documents.find((document) => document.docType === docType)?.label ?? ""] },
        refs: { docTypes: [docType], observationIds: [observationOf(context, docType).observationId] },
      };
    },
  };
}
