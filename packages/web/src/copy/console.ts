// Every string the shell of the firm's console shows, in Spanish (rioplatense, voseo) and English: the
// console is for the customs brokerage firm; importer-facing texts live in packages/bff/src/copy/es-AR.ts
// and supplier emails in packages/bff/src/copy/en.ts (docs/design-brief.md §10). Each view keeps its own
// texts in views/<view>/copy.ts; this file keeps the shell and the shared keys. The English has exactly
// the shape of the Spanish (`satisfies`) and the console's language picks one at render time
// (copy/localized.ts, ADR-0020). Wording follows the landing's English: firm, dossier, importer, supplier.
import type { PendingKind } from "@legajo/shared";
import { localized, type Widen } from "./localized";

export const PRODUCT_NAME = "Legajo listo";

const es = {
  app: {
    tagline: "Consola del estudio",
    loading: "Cargando la consola…",
    signOut: "Cerrar sesión",
    roleLabel: "Rol",
    firmLabel: "Estudio",
    skipToContent: "Ir al contenido",
    syntheticData: "Datos 100 % sintéticos",
    navigation: "Secciones de la consola",
  },
  roles: {
    BROKER: "Despachante",
    ANALYST: "Analista",
    GUEST: "Invitado",
  },
  account: {
    menu: "Mi cuenta",
    changePassword: "Cambiar contraseña",
    totp: "Código de verificación",
    language: "Idioma",
    languageNotSaved: "No pudimos guardar el idioma en tu cuenta: queda elegido solo en este navegador.",
    dismiss: "Cerrar aviso",
  },
  login: {
    unconfiguredTitle: "Consola sin configurar",
    unconfiguredLead: "Faltan variables de build del stage (infra/auth.ts). Sin ellas no hay login.",
    noAccessTitle: "Tu usuario no tiene un estudio asignado",
    noAccessLead: "Ingresaste correctamente, pero el usuario todavía no pertenece a ningún estudio. Pedile al despachante que te invite.",
  },
  errors: {
    notFoundTitle: "Esta página no existe",
    notFoundLead: "Revisá el enlace o volvé al inicio.",
    forbiddenTitle: "Tu rol no tiene acceso a esta vista",
    forbiddenLead: "Si creés que deberías verla, pedile al despachante que ajuste tu rol.",
    backHome: "Volver al inicio",
  },
  nav: {
    groups: {
      files: "Legajos",
      parties: "Partes",
      demo: "Demo",
      control: "Control",
    },
  },
  views: {
    operations: {
      title: "Operaciones",
      description: "Cada importación con su ETA, el estado del legajo, quién debe qué y el próximo evento.",
    },
    dossier: {
      title: "Detalle del legajo",
      description: "Documentos, lecturas y observaciones de la operación, la línea de tiempo y los pendientes con su motivo.",
    },
    escalations: {
      title: "Escalamientos",
      description: "Lo que el agente derivó al estudio, por motivo.",
    },
    registry: {
      title: "Registro",
      description: "Importadores con su opt-in y proveedores con sus contactos.",
    },
    clock: {
      title: "Reloj de demo",
      description: "Hora simulada del mundo y próximos eventos.",
    },
    simulator: {
      title: "Simulador de teléfono",
      description: "WhatsApp en modo simulado: los hilos de los importadores del estudio.",
    },
    mailbox: {
      title: "Buzón de demo",
      description: "Emails recibidos por los buzones simulados del estudio y de sus proveedores.",
    },
    metrics: {
      title: "Métricas",
      description: "Minutos humanos por legajo, intervenciones, legajos completos a tiempo y costo (con supuestos rotulados).",
    },
    audit: {
      title: "Bitácora",
      description: "Cada decisión con la regla aplicada, el evento que la disparó y quién la tomó.",
    },
  },
  placeholder: {
    title: "Vista en construcción",
    lead: "Esta vista llega en una próxima entrega del plan de construcción.",
  },
  tour: {
    title: "Recorrido guiado",
    open: "Recorrido guiado",
    close: "Cerrar el recorrido",
    lead: "Los pasos del recorrido llegan en una próxima entrega de la consola.",
  },
  time: {
    weekdays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
    /** "14/10": the day and the month of an instant, as the console writes them. */
    dayMonth: (day: number, month: number) => `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`,
    /** "14/10/2026" */
    dayMonthYear: (day: number, month: number, year: number) => `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`,
  },
  clock: {
    region: "Hora simulada del mundo",
    label: "Hora simulada",
    paused: "reloj de demo en pausa",
    running: (until: string | undefined) => (until === undefined ? "reloj en vivo" : `reloj en vivo hasta las ${until}`),
    loading: "Leyendo la hora simulada…",
    unavailable: "Hora simulada no disponible por ahora.",
    retry: "Reintentar",
    next: "Avanzar al próximo evento",
    plusHour: "+1 h",
    plusHourLabel: "Avanzar una hora",
    plusDay: "+1 día",
    plusDayLabel: "Avanzar un día",
    pending: {
      TURN: "El agente está escribiendo… (~1 min)",
      EVENT: "Esperando: un evento de la operación en proceso (~30 s)",
      MAIL: "Esperando: email en tránsito por SES (~30 s)",
      SCAN: "Esperando: escaneo del PDF subido (~1 min)",
    } satisfies Record<PendingKind, string>,
    operation: (number: string) => `operación ${number}`,
    more: (count: number) => (count === 1 ? "y 1 pendiente más" : `y ${count} pendientes más`),
    disabled: "Los controles del reloj se habilitan cuando termina lo que está en curso.",
    force: "Avanzar igual",
    forceWarning: "El mundo sigue ocupado hace más de 5 minutos: si avanzás igual, la historia puede quedar desordenada.",
    busyRefused: "El mundo se ocupó mientras tanto: esperá a que termine y volvé a intentar.",
  },
  session: {
    otherSession: (minutes: number) =>
      minutes < 1
        ? "Otra sesión usó este mundo hace menos de un minuto: si compartís la cuenta, usá otra cuenta de invitado."
        : `Otra sesión usó este mundo hace ${minutes} min: si compartís la cuenta, usá otra cuenta de invitado.`,
    /** The fixed English line under the Spanish notice; the English console shows only its own. */
    otherSessionEn: "This world is in use by another session: please use another guest account.",
  },
  scope: {
    label: "Alcance",
    etaFrom: "ETA desde",
    etaTo: "ETA hasta",
    clear: "Todas las ETA",
  },
} as const;

export type ConsoleCopy = Widen<typeof es>;

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const en = {
  app: {
    tagline: "Firm console",
    loading: "Loading the console…",
    signOut: "Sign out",
    roleLabel: "Role",
    firmLabel: "Firm",
    skipToContent: "Skip to content",
    syntheticData: "100 % synthetic data",
    navigation: "Console sections",
  },
  roles: {
    BROKER: "Broker",
    ANALYST: "Analyst",
    GUEST: "Guest",
  },
  account: {
    menu: "My account",
    changePassword: "Change password",
    totp: "Verification code",
    language: "Language",
    languageNotSaved: "We could not save the language to your account: it stays chosen in this browser only.",
    dismiss: "Dismiss",
  },
  login: {
    unconfiguredTitle: "Console not configured",
    unconfiguredLead: "The stage's build variables are missing (infra/auth.ts). Without them there is no sign-in.",
    noAccessTitle: "Your user has no firm assigned",
    noAccessLead: "You signed in correctly, but the user does not belong to any firm yet. Ask the broker to invite you.",
  },
  errors: {
    notFoundTitle: "This page does not exist",
    notFoundLead: "Check the link or go back to the start.",
    forbiddenTitle: "Your role cannot open this view",
    forbiddenLead: "If you think you should see it, ask the broker to adjust your role.",
    backHome: "Back to the start",
  },
  nav: {
    groups: {
      files: "Dossiers",
      parties: "Parties",
      demo: "Demo",
      control: "Control",
    },
  },
  views: {
    operations: {
      title: "Operations",
      description: "Every import with its ETA, the state of the dossier, who owes what and the next event.",
    },
    dossier: {
      title: "Dossier detail",
      description: "The operation's documents, readings and observations, its timeline and the pending items with their reason.",
    },
    escalations: {
      title: "Escalations",
      description: "What the agent handed over to the firm, by reason.",
    },
    registry: {
      title: "Registry",
      description: "Importers with their opt-in and suppliers with their contacts.",
    },
    clock: {
      title: "Demo clock",
      description: "The world's simulated time and its next events.",
    },
    simulator: {
      title: "Phone simulator",
      description: "WhatsApp in simulated mode: the threads of the firm's importers.",
    },
    mailbox: {
      title: "Demo mailbox",
      description: "Emails received by the simulated mailboxes of the firm and of its suppliers.",
    },
    metrics: {
      title: "Metrics",
      description: "Human minutes per dossier, interventions, dossiers complete on time and cost (with labelled assumptions).",
    },
    audit: {
      title: "Audit log",
      description: "Every decision with the rule applied, the event that triggered it and who made it.",
    },
  },
  placeholder: {
    title: "View under construction",
    lead: "This view arrives in an upcoming delivery of the build plan.",
  },
  tour: {
    title: "Guided tour",
    open: "Guided tour",
    close: "Close the tour",
    lead: "The steps of the tour arrive in an upcoming delivery of the console.",
  },
  time: {
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    dayMonth: (day: number, month: number) => `${day} ${MONTHS_EN[month - 1] ?? ""}`,
    dayMonthYear: (day: number, month: number, year: number) => `${day} ${MONTHS_EN[month - 1] ?? ""} ${year}`,
  },
  clock: {
    region: "The world's simulated time",
    label: "Simulated time",
    paused: "demo clock paused",
    running: (until: string | undefined) => (until === undefined ? "live clock" : `live clock until ${until}`),
    loading: "Reading the simulated time…",
    unavailable: "Simulated time is not available right now.",
    retry: "Retry",
    next: "Advance to the next event",
    plusHour: "+1 h",
    plusHourLabel: "Advance one hour",
    plusDay: "+1 day",
    plusDayLabel: "Advance one day",
    pending: {
      TURN: "The agent is writing… (~1 min)",
      EVENT: "Waiting: an event of the operation is being processed (~30 s)",
      MAIL: "Waiting: email in transit through SES (~30 s)",
      SCAN: "Waiting: scan of the uploaded PDF (~1 min)",
    } satisfies Record<PendingKind, string>,
    operation: (number: string) => `operation ${number}`,
    more: (count: number) => (count === 1 ? "and 1 more pending" : `and ${count} more pending`),
    disabled: "The clock controls turn on when what is in progress finishes.",
    force: "Advance anyway",
    forceWarning: "The world has been busy for more than 5 minutes: if you advance anyway, the story may end up out of order.",
    busyRefused: "The world became busy in the meantime: wait for it to finish and try again.",
  },
  session: {
    otherSession: (minutes: number) =>
      minutes < 1
        ? "Another session used this world less than a minute ago: if you share the account, use another guest account."
        : `Another session used this world ${minutes} min ago: if you share the account, use another guest account.`,
    otherSessionEn: "This world is in use by another session: please use another guest account.",
  },
  scope: {
    label: "Scope",
    etaFrom: "ETA from",
    etaTo: "ETA to",
    clear: "All ETAs",
  },
} satisfies ConsoleCopy;

export const copy: ConsoleCopy = localized({ es, en });
