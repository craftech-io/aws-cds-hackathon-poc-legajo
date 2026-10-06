// Texts of the metrics view (`/app/metrics`, docs/design-brief.md §8, FL-085). Every number says its
// N, the world it comes from and whether it is measured, from the scripted agent or an assumption.
// Spanish and English with the same shape; the console's language picks one at render time
// (copy/localized.ts).
import { localized, type Widen } from "../../copy/localized";

const es = {
  tabs: {
    label: "Fuente de las métricas",
    WORLD: "Este mundo",
    BATCH_REAL: "Lote · agente real",
    BATCH_SCRIPTED: "Lote · agente guionado",
  },
  tabLead: {
    WORLD: "Las operaciones de tu mundo, medidas mientras las usás.",
    BATCH_REAL: "20 operaciones de entrada corridas en el stage con el agente real, reloj en pausa y tope de turnos.",
    BATCH_SCRIPTED: "200 operaciones de entrada corridas por el pipeline local (política, matriz, hitos y verificación reales) con un agente guionado.",
  },
  summary: (n: number, label: string) => `N = ${n} ${n === 1 ? "legajo" : "legajos"} · ${label}`,
  kpis: {
    humanMinutesPerDossier: "Minutos humanos por legajo",
    manualBaselineMinutes: "Base manual por legajo",
    consoleMinutesObserved: "Tiempo de consola observado (secundaria)",
    interventionsPerDossier: "Intervenciones humanas por legajo",
    completeBeforeArrivalPct: "Legajos completos 72 h antes del arribo",
    correctResponsiblePct: "Observaciones al responsable correcto",
    policyViolations: "Violaciones de política",
    costPerDossierUsd: "Costo por legajo",
    latencyP50Ms: "Latencia p50 (evento → primer saliente)",
    latencyP95Ms: "Latencia p95 (evento → primer saliente)",
  },
  labels: {
    MEASURED: "medido",
    SCRIPTED_AGENT: "agente guionado",
    ASSUMPTION: "supuesto",
  },
  sources: {
    WORLD: "este mundo",
    BATCH: "lote de métricas",
    FIRM_SETTINGS: "configuración del estudio",
    AUDIT_LOG: "bitácora",
  },
  gaps: {
    NOT_APPLICABLE: "no aplica",
    NO_DATA: "sin datos",
    UNVERIFIED_RATES: "sin tarifa verificada",
  },
  hint: (n: number, source: string, label: string) => `N = ${n} · fuente: ${source} · ${label}`,
  notes: {
    humanMinutes: "Acciones humanas medidas × minutos por acción que declara el estudio (supuesto).",
    baseline: "Estimación propia del equipo, desglosada abajo (supuesto).",
    notApplicable: "Con agente guionado no se compara la asignación con la verdad de base.",
    whatsappAsLive: "WhatsApp corre en modo simulado: cada mensaje se valoriza como si fuera vivo.",
    missingRates: (count: number) => (count === 1 ? "Falta verificar 1 tarifa." : `Faltan verificar ${count} tarifas.`),
    violations: "Tiene que ser 0; al lado, las decisiones denegadas y diferidas por regla.",
  },
  units: {
    minutes: (value: string) => `${value} min`,
    percent: (value: string) => `${value} %`,
    usd: (value: string) => `USD ${value}`,
    seconds: (value: string) => `${value} s`,
  },
  baseline: {
    title: "Base manual declarada",
    description: "Cuánto le lleva hoy al estudio un legajo sin el agente: contactos por legajo × minutos por contacto + revisión.",
    action: "Qué",
    count: "Cantidad",
    minutes: "Minutos",
    total: "Total",
    label: "supuesto",
    basis: (source: string) => `Fuente: ${source}`,
  },
  byRule: {
    title: "La política frenando al agente",
    description: "Decisiones denegadas y diferidas por regla en este mundo, junto a las 0 violaciones.",
  },
  export: {
    button: "Exportar CSV",
    done: "CSV descargado.",
  },
} as const;

export type MetricsCopy = Widen<typeof es>;

const en = {
  tabs: {
    label: "Source of the metrics",
    WORLD: "This world",
    BATCH_REAL: "Batch · real agent",
    BATCH_SCRIPTED: "Batch · scripted agent",
  },
  tabLead: {
    WORLD: "The operations of your world, measured while you use them.",
    BATCH_REAL: "20 input operations run on the stage with the real agent, the clock paused and a turn cap.",
    BATCH_SCRIPTED: "200 input operations run through the local pipeline (real policy, matrix, milestones and verification) with a scripted agent.",
  },
  summary: (n: number, label: string) => `N = ${n} ${n === 1 ? "dossier" : "dossiers"} · ${label}`,
  kpis: {
    humanMinutesPerDossier: "Human minutes per dossier",
    manualBaselineMinutes: "Manual baseline per dossier",
    consoleMinutesObserved: "Observed console time (secondary)",
    interventionsPerDossier: "Human interventions per dossier",
    completeBeforeArrivalPct: "Dossiers complete 72 h before arrival",
    correctResponsiblePct: "Observations to the right party",
    policyViolations: "Policy violations",
    costPerDossierUsd: "Cost per dossier",
    latencyP50Ms: "p50 latency (event → first outbound)",
    latencyP95Ms: "p95 latency (event → first outbound)",
  },
  labels: {
    MEASURED: "measured",
    SCRIPTED_AGENT: "scripted agent",
    ASSUMPTION: "assumption",
  },
  sources: {
    WORLD: "this world",
    BATCH: "metrics batch",
    FIRM_SETTINGS: "firm settings",
    AUDIT_LOG: "audit log",
  },
  gaps: {
    NOT_APPLICABLE: "not applicable",
    NO_DATA: "no data",
    UNVERIFIED_RATES: "no verified rate",
  },
  hint: (n: number, source: string, label: string) => `N = ${n} · source: ${source} · ${label}`,
  notes: {
    humanMinutes: "Measured human actions × minutes per action declared by the firm (assumption).",
    baseline: "The team's own estimate, broken down below (assumption).",
    notApplicable: "With a scripted agent the assignment is not compared with the ground truth.",
    whatsappAsLive: "WhatsApp runs in simulated mode: every message is priced as if it were live.",
    missingRates: (count: number) => (count === 1 ? "1 rate still to verify." : `${count} rates still to verify.`),
    violations: "It must be 0; next to it, the decisions denied and deferred by rule.",
  },
  units: {
    minutes: (value: string) => `${value} min`,
    percent: (value: string) => `${value} %`,
    usd: (value: string) => `USD ${value}`,
    seconds: (value: string) => `${value} s`,
  },
  baseline: {
    title: "Declared manual baseline",
    description: "How long a dossier takes the firm today without the agent: contacts per dossier × minutes per contact + review.",
    action: "What",
    count: "Count",
    minutes: "Minutes",
    total: "Total",
    label: "assumption",
    basis: (source: string) => `Source: ${source}`,
  },
  byRule: {
    title: "The policy holding the agent back",
    description: "Decisions denied and deferred by rule in this world, next to the 0 violations.",
  },
  export: {
    button: "Export CSV",
    done: "CSV downloaded.",
  },
} satisfies MetricsCopy;

export const metricsCopy: MetricsCopy = localized({ es, en });
