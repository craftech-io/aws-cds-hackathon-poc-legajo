// Texts of the sign-in screens, the recent-login step-up and the optional TOTP enrolment. Error texts never say
// whether an email has an account (lib/auth/errors.ts).
import type { AuthFlowErrorCode } from "../../lib/auth/errors";
import type { PasswordRule } from "../../lib/auth/credentials";

export const loginCopy = {
  panel: {
    tagline: "Agente de coordinación para estudios de despachantes de aduana",
    title: "Cada legajo completo antes del arribo.",
    lead: "Factura comercial, packing list y certificado de origen: el agente los pide al importador por WhatsApp y al proveedor por email, decide quién corrige cada observación y te deja el legajo listo para aprobar.",
    points: ["La aprobación es siempre tuya", "Política de contacto en código", "Datos 100 % sintéticos en esta demo"],
  },
  credentials: {
    title: "Ingresá a la consola",
    lead: "Usá el email y la contraseña de tu invitación.",
    email: "Email",
    password: "Contraseña",
    submit: "Ingresar",
    forgot: "Olvidé mi contraseña",
    hint: "Tu usuario lo crea el estudio por invitación. Si no lo tenés, pedíselo al despachante.",
    passwordReset: "Listo: tu contraseña cambió. Ingresá con la nueva.",
    sessionExpired: "La sesión venció. Ingresá de nuevo.",
  },
  password: {
    show: "Mostrar",
    hide: "Ocultar",
    rulesTitle: "La contraseña necesita:",
    rules: {
      length: "12 caracteres o más",
      lower: "una minúscula",
      upper: "una mayúscula",
      number: "un número",
      symbol: "un símbolo (por ejemplo ! # $ -)",
    } satisfies Record<PasswordRule, string>,
    confirm: "Repetí la contraseña",
    mismatch: "Las dos contraseñas no coinciden.",
    outerSpaces: "La contraseña no puede empezar ni terminar con un espacio.",
  },
  newPassword: {
    title: "Elegí tu contraseña",
    lead: "Es tu primer ingreso: reemplazá la contraseña temporal por una propia.",
    field: "Contraseña nueva",
    submit: "Guardar y seguir",
  },
  mfaSetup: {
    title: "Activá el código de verificación",
    leadRequired: "Tu cuenta pide el código de verificación (TOTP). Se configura una sola vez.",
    leadOptional: "Es opcional y suma una capa de seguridad a tu usuario. Se configura una sola vez.",
    steps: [
      "Abrí tu app de autenticación: Google Authenticator, Microsoft Authenticator, 1Password o similar.",
      "Escaneá el código QR, o cargá la clave a mano.",
      "Escribí el código de 6 dígitos que te muestra la app.",
    ],
    qrLabel: "Código QR para tu app de autenticación",
    manualKey: "Clave para cargar a mano",
    code: "Código de 6 dígitos",
    submit: "Activar",
    skip: "Ahora no",
  },
  totp: {
    title: "Código de verificación",
    lead: "Escribí el código de 6 dígitos que muestra tu app de autenticación.",
    code: "Código",
    submit: "Verificar",
  },
  forgot: {
    title: "Restablecé tu contraseña",
    lead: "Escribí el email de tu usuario y te mandamos un código para elegir una contraseña nueva.",
    submit: "Enviar código",
  },
  reset: {
    title: "Revisá tu email",
    lead: (email: string) =>
      `Si ${email} corresponde a un usuario de la consola, te mandamos un código de 6 dígitos. Si no llega en unos minutos, revisá el correo no deseado o pedile al despachante que te invite de nuevo.`,
    code: "Código del email",
    submit: "Cambiar la contraseña",
  },
  back: "Volver al ingreso",
  otherUser: "Ingresar con otro usuario",
  working: "Un momento…",
  errors: {
    INVALID_CREDENTIALS: "El email o la contraseña no son correctos. Si no recordás la contraseña, podés restablecerla.",
    INVALID_CODE: "El código no es válido o ya venció. Probá con el que muestra ahora.",
    WEAK_PASSWORD: "La contraseña no cumple los requisitos.",
    SESSION_EXPIRED: "Pasó demasiado tiempo. Empezá de nuevo con tu email y tu contraseña.",
    TOO_MANY_ATTEMPTS: "Demasiados intentos. Esperá unos minutos y volvé a probar.",
    UNAVAILABLE: "No pudimos comunicarnos con el servicio de ingreso. Revisá tu conexión y reintentá.",
    UNSUPPORTED: "Tu usuario pide un método de verificación que la consola no admite. Pedile ayuda al despachante.",
    DIFFERENT_USER: "Ese no es el usuario de esta sesión. Confirmá con el tuyo.",
  } satisfies Record<AuthFlowErrorCode, string>,
  stepUp: {
    title: "Confirmá que sos vos",
    lead: "Aprobar o reabrir un legajo pide haber ingresado en los últimos 15 minutos. Confirmá con tu contraseña.",
    done: "Listo. Ya podés volver a intentar la acción.",
  },
  enroll: {
    title: "Código de verificación",
    done: "Código activado. Desde el próximo ingreso te lo vamos a pedir.",
    unavailable: "No pudimos preparar el código de verificación. Reintentá en unos segundos.",
    retry: "Reintentar",
  },
  close: "Cerrar",
  legal: { privacy: "Privacidad", terms: "Términos" },
} as const;
