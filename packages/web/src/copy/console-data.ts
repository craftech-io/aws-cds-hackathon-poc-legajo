// Texts shared by the data-driven views: loading and error states and the refusal of each BFF
// `reason` (packages/bff/src/auth/errors.ts and the routers), in Spanish and English (copy/localized.ts).
// The server messages are English and technical; what the broker reads comes from here.
import { localized, type Widen } from "./localized";

const es = {
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

export type DataCopy = Widen<typeof es>;

const en = {
  loading: "Loading…",
  updating: "Updating…",
  retry: "Retry",
  reference: "Reference code",
  recentLogin: {
    confirm: "Confirm with my password",
  },
  unauthorized: {
    signIn: "Sign in again",
  },
  byKind: {
    recentLogin: "Approving or reopening a dossier requires having signed in with your password in the last 15 minutes.",
    unauthorized: "Your session expired. Sign in again.",
    forbidden: "Your role cannot access this information or action.",
    notFound: "We could not find what you were looking for.",
    conflict: "Someone already resolved this or it changed while you were looking at it. Refresh and try again.",
    invalid: "The data did not pass validation.",
    precondition: "This action cannot be done in the current state.",
    unavailable: "The service did not respond. Try again in a few seconds.",
    network: "We could not reach the console. Check your connection and try again.",
    unknown: "Something went wrong. If it happens again, give the reference code to the technical team.",
  },
  byReason: {
    LOGIN_NOT_RECENT: "More than 15 minutes have passed since you signed in. Confirm your password to continue.",
    ROLE_NOT_ALLOWED: "Your role cannot take this action.",
    CROSS_FIRM: "That data does not belong to your firm.",
    INPUT_TOO_LARGE: "The request covers too much data at once. Narrow the selection and try again.",
    BROKER_INACTIVE: "Your user is no longer active in the firm.",
    PRINCIPAL_INCOMPLETE: "Your user does not have a firm or a role assigned yet.",
    AUTH_UNAVAILABLE: "The sign-in service did not respond. Try again in a few seconds.",
    WORLD_BUSY: "The world is busy: wait for what is in progress to finish and try again.",
  },
} satisfies DataCopy;

export const dataCopy: DataCopy = localized({ es, en });
