// Texts of the operations view (docs/design-brief.md §6, row 1), in rioplatense Spanish and English,
// for the firm. The English has exactly the shape of the Spanish (`satisfies`) and each text resolves
// to the console's language when it is read (copy/localized.ts).
import type { DossierStatus } from "@legajo/shared";
import { localized, type Widen } from "../../copy/localized";
import type { Risk } from "../dossier/risk";
import type { SecondActNumber } from "./operations-model";

const es = {
  fictitious: "Empresas, personas, buques y transportistas de esta demo son ficticios.",
  caption: "Operaciones del mundo, con la historia principal primero",
  columns: {
    operation: "Operación",
    parties: "Importador y proveedor",
    eta: "ETA",
    toArrival: "Al arribo y riesgo",
    dossier: "Legajo y escalamientos",
    documents: "Documentos",
    control: "Conversación",
    next: "Próximo evento",
  },
  mainStory: "Historia principal",
  secondAct: {
    "4474": "Rebote del email al proveedor",
    "4477": "Documento que el lector no reconoce",
    "4478": "Proveedor que no responde",
    "4487": "Legajo aprobado: estados del despacho",
    "4488": "Legajo listo para revisión",
  } satisfies Record<SecondActNumber, string>,
  vessel: (vessel: string) => `Buque ${vessel}`,
  filters: {
    status: "Estado del legajo",
    risk: "Riesgo",
    all: "Todos",
    statuses: {
      OPEN: "Abiertos",
      READY_FOR_REVIEW: "Listos para revisión",
      APPROVED: "Aprobados",
      REOPENED: "Reabiertos",
    } satisfies Record<DossierStatus, string>,
    risks: {
      AT_RISK: "En riesgo",
      ON_TRACK: "En plazo",
      COMPLETE: "Completos",
    } satisfies Record<Risk, string>,
  },
  riskHint: "En riesgo: al legajo le faltan documentos a 72 h o menos del arribo (hora simulada del mundo).",
  unknown: "—",
  toArrival: (days: number, hours: number) => (days > 0 ? `${days} d ${hours} h` : `${hours} h`),
  arrived: "Ya arribó",
  next: {
    none: "Sin eventos pendientes",
    later: (date: string) => `Después del ${date}`,
  },
  escalationsOpen: (count: number) => (count === 1 ? "1 escalamiento abierto" : `${count} escalamientos abiertos`),
  processError: "Con error de proceso",
  openDossier: (number: string) => `Abrir el legajo de la operación ${number}`,
  empty: {
    title: "Todavía no hay operaciones en este mundo",
    lead: "Creá una con «Nueva operación» a partir de su número en la plataforma de gestión aduanera.",
  },
  emptyFiltered: {
    title: "Ninguna operación coincide con los filtros",
    lead: "Cambiá el estado, el riesgo o el rango de ETA.",
  },
  create: {
    open: "Nueva operación",
    title: "Nueva operación desde la plataforma",
    lead: "El estudio trae la operación de la plataforma de gestión aduanera (simulada) por su número: se crea el legajo con sus tres documentos y los cinco hitos relativos a la ETA.",
    number: "Número de operación",
    numberHint: "Cuatro dígitos, como figura en la plataforma.",
    invalid: "El número tiene que tener cuatro dígitos.",
    submit: "Crear operación",
    working: "Creando…",
    close: "Cerrar",
    notFound: "La plataforma no tiene una operación con ese número para este estudio.",
    conflict: "Esa operación ya existe en este mundo.",
  },
} as const;

export type OperationsCopy = Widen<typeof es>;

const en = {
  fictitious: "The companies, people, vessels and carriers of this demo are fictitious.",
  caption: "Operations of the world, main story first",
  columns: {
    operation: "Operation",
    parties: "Importer and supplier",
    eta: "ETA",
    toArrival: "To arrival and risk",
    dossier: "Dossier and escalations",
    documents: "Documents",
    control: "Conversation",
    next: "Next event",
  },
  mainStory: "Main story",
  secondAct: {
    "4474": "Bounced email to the supplier",
    "4477": "Document the reader does not recognize",
    "4478": "Supplier who does not answer",
    "4487": "Approved dossier: dispatch statuses",
    "4488": "Dossier ready for review",
  } satisfies Record<SecondActNumber, string>,
  vessel: (vessel: string) => `Vessel ${vessel}`,
  filters: {
    status: "Dossier status",
    risk: "Risk",
    all: "All",
    statuses: {
      OPEN: "Open",
      READY_FOR_REVIEW: "Ready for review",
      APPROVED: "Approved",
      REOPENED: "Reopened",
    } satisfies Record<DossierStatus, string>,
    risks: {
      AT_RISK: "At risk",
      ON_TRACK: "On track",
      COMPLETE: "Complete",
    } satisfies Record<Risk, string>,
  },
  riskHint: "At risk: the dossier is missing documents 72 h or less before arrival (the world's simulated time).",
  unknown: "—",
  toArrival: (days: number, hours: number) => (days > 0 ? `${days} d ${hours} h` : `${hours} h`),
  arrived: "Already arrived",
  next: {
    none: "No pending events",
    later: (date: string) => `After ${date}`,
  },
  escalationsOpen: (count: number) => (count === 1 ? "1 open escalation" : `${count} open escalations`),
  processError: "Process error",
  openDossier: (number: string) => `Open the dossier of operation ${number}`,
  empty: {
    title: "No operations in this world yet",
    lead: "Create one with “New operation” from its number in the customs management platform.",
  },
  emptyFiltered: {
    title: "No operation matches the filters",
    lead: "Change the status, the risk or the ETA range.",
  },
  create: {
    open: "New operation",
    title: "New operation from the platform",
    lead: "The firm brings the operation from the customs management platform (simulated) by its number: the dossier is created with its three documents and the five milestones relative to the ETA.",
    number: "Operation number",
    numberHint: "Four digits, as shown on the platform.",
    invalid: "The number must have four digits.",
    submit: "Create operation",
    working: "Creating…",
    close: "Close",
    notFound: "The platform has no operation with that number for this firm.",
    conflict: "That operation already exists in this world.",
  },
} satisfies OperationsCopy;

export const operationsCopy: OperationsCopy = localized({ es, en });
