// Every string the firm's console shows. Rioplatense Spanish (voseo): the console is for the
// customs brokerage firm; importer-facing texts live in packages/bff/src/copy/es-AR.ts and supplier
// emails in packages/bff/src/copy/en.ts (docs/design-brief.md §10). From wave 5 on, each view keeps
// its own texts in views/<view>/copy.ts; this file keeps the shell and the shared keys.

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
  },
  roles: {
    BROKER: "Despachante",
    ANALYST: "Analista",
    JUDGE: "Jurado",
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
} as const;
