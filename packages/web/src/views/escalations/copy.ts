// Texts of the escalations inbox (docs/design-brief.md §6, row 3), in rioplatense Spanish and English,
// for the firm. The English has exactly the shape of the Spanish (`satisfies`) and each text resolves
// to the console's language when it is read (copy/localized.ts).
import { localized, type Widen } from "../../copy/localized";

const es = {
  caption: "Escalamientos abiertos, el más antiguo primero",
  filter: "Motivo",
  all: "Todos",
  columns: {
    operation: "Operación",
    reason: "Motivo",
    summary: "Resumen",
    opened: "Abierto",
    by: "Por",
  },
  openFor: (days: number, hours: number) => (days > 0 ? `hace ${days} d ${hours} h` : `hace ${hours} h`),
  empty: {
    title: "No hay escalamientos abiertos",
    lead: "Cuando el agente o el sistema derivan algo al estudio, aparece acá con su motivo.",
  },
  emptyFiltered: "Ningún escalamiento abierto con ese motivo",
  open: (number: string) => `Escalamiento de la operación ${number}`,
  drawer: {
    operation: (number: string) => `Operación ${number}`,
    reason: "Motivo",
    summary: "Resumen",
    noSummary: "Sin resumen.",
    opened: (when: string, by: string) => `Abierto el ${when} por ${by}`,
    viewDossier: "Ver el legajo",
    take: "Tomar conversación",
    taking: "Tomando…",
    takeLead: "Tomar la conversación deja al agente en pausa en esta operación y abre el legajo para escribirle al importador.",
    resolveTitle: "Resolver",
    resolution: "Cómo se resolvió",
    resolutionHint: "Queda en la bitácora con tu usuario y la hora simulada.",
    resolutionRequired: "Escribí cómo se resolvió.",
    resolve: "Resolver",
    resolving: "Resolviendo…",
    resolved: "Escalamiento resuelto.",
    close: "Cerrar",
  },
} as const;

export type EscalationsCopy = Widen<typeof es>;

const en = {
  caption: "Open escalations, oldest first",
  filter: "Reason",
  all: "All",
  columns: {
    operation: "Operation",
    reason: "Reason",
    summary: "Summary",
    opened: "Opened",
    by: "By",
  },
  openFor: (days: number, hours: number) => (days > 0 ? `${days} d ${hours} h ago` : `${hours} h ago`),
  empty: {
    title: "No open escalations",
    lead: "When the agent or the system hands something over to the firm, it shows up here with its reason.",
  },
  emptyFiltered: "No open escalation with that reason",
  open: (number: string) => `Escalation of operation ${number}`,
  drawer: {
    operation: (number: string) => `Operation ${number}`,
    reason: "Reason",
    summary: "Summary",
    noSummary: "No summary.",
    opened: (when: string, by: string) => `Opened on ${when} by ${by}`,
    viewDossier: "View the dossier",
    take: "Take over the conversation",
    taking: "Taking over…",
    takeLead: "Taking over the conversation pauses the agent on this operation and opens the dossier to write to the importer.",
    resolveTitle: "Resolve",
    resolution: "How it was resolved",
    resolutionHint: "It is recorded in the audit log with your user and the simulated time.",
    resolutionRequired: "Write how it was resolved.",
    resolve: "Resolve",
    resolving: "Resolving…",
    resolved: "Escalation resolved.",
    close: "Close",
  },
} satisfies EscalationsCopy;

export const escalationsCopy: EscalationsCopy = localized({ es, en });
