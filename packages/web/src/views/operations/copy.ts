// Texts of the operations view (docs/design-brief.md §6, row 1). Rioplatense Spanish, for the firm.
import type { DossierStatus } from "@legajo/shared";
import type { Risk } from "../dossier/risk";
import type { SecondActNumber } from "./operations-model";

export const operationsCopy = {
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
