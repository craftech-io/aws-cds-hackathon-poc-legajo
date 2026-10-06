// Texts shared by the data-driven views: loading and error states and the refusal of each BFF
// `reason` (packages/bff/src/auth/errors.ts and the routers). The server messages are English and
// technical; what the broker reads comes from here.

export const dataCopy = {
  loading: "Cargando…",
  updating: "Actualizando…",
  retry: "Reintentar",
  reference: "Código de referencia",
  recentLogin: {
    confirm: "Confirmar con mi contraseña",
  },
  unauthorized: {
    signIn: "Ingresar de nuevo",
  },
  byKind: {
    recentLogin: "Aprobar o reabrir un legajo pide haber ingresado con tu contraseña en los últimos 15 minutos.",
    unauthorized: "La sesión venció. Ingresá de nuevo.",
    forbidden: "Tu rol no tiene acceso a esta información o acción.",
    notFound: "No encontramos lo que buscabas.",
    conflict: "Alguien ya resolvió esto o cambió mientras lo mirabas. Actualizá y volvé a intentar.",
    invalid: "Los datos no pasaron la validación.",
    precondition: "La acción no se puede hacer en el estado actual.",
    unavailable: "El servicio no respondió. Probá de nuevo en unos segundos.",
    network: "No pudimos comunicarnos con la consola. Revisá tu conexión y reintentá.",
    unknown: "Algo salió mal. Si se repite, pasale el código de referencia al equipo técnico.",
  },
  byReason: {
    LOGIN_NOT_RECENT: "Pasaron más de 15 minutos desde que ingresaste. Confirmá tu contraseña para seguir.",
    ROLE_NOT_ALLOWED: "Tu rol no puede hacer esta acción.",
    CROSS_FIRM: "Ese dato no pertenece a tu estudio.",
    INPUT_TOO_LARGE: "La solicitud abarca demasiados datos a la vez. Achicá la selección y volvé a intentar.",
    BROKER_INACTIVE: "Tu usuario ya no está activo en el estudio.",
    PRINCIPAL_INCOMPLETE: "Tu usuario todavía no tiene un estudio o un rol asignado.",
    AUTH_UNAVAILABLE: "El servicio de ingreso no respondió. Probá de nuevo en unos segundos.",
    WORLD_BUSY: "El mundo está ocupado: esperá a que termine lo que está en curso y volvé a intentar.",
  } as Readonly<Record<string, string>>,
} as const;
