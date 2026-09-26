// Texts of the metrics view (`/app/metrics`, docs/design-brief.md §8, FL-085). Every number says its
// N, the world it comes from and whether it is measured, from the scripted agent or an assumption.
export const metricsCopy = {
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
