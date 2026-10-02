// Every string the shell of the firm's console shows. Rioplatense Spanish (voseo): the console is for
// the customs brokerage firm; importer-facing texts live in packages/bff/src/copy/es-AR.ts and
// supplier emails in packages/bff/src/copy/en.ts (docs/design-brief.md §10). From wave 5 on, each
// view keeps its own texts in views/<view>/copy.ts; this file keeps the shell and the shared keys.
import type { PendingKind } from "@legajo/shared";

export const PRODUCT_NAME = "Legajo listo";

export const copy = {
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
    otherSessionEn: "This world is in use by another session: please use another guest account.",
  },
  scope: {
    label: "Alcance",
    etaFrom: "ETA desde",
    etaTo: "ETA hasta",
    clear: "Todas las ETA",
  },
} as const;
