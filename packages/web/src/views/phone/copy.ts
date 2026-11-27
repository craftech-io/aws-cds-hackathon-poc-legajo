// Texts of `/verify-phone` (ADR-0021) in Spanish and English, the same shape in both (`satisfies`).
// They travel in the screen's own chunk, never in the landing's.
import type { Language } from "@legajo/shared";
import type { SmsLimitName } from "@legajo/shared/phone-verification";

const ES = {
  enrolTitle: "Verificá tu celular",
  enrolLead: "Para usar la demo, verificá un celular tuyo. Te mandamos un código por SMS; en cada ingreso te vamos a pedir uno nuevo.",
  signInTitle: "Ingresá el código del SMS",
  signInLead: (hint: string) => `Para entrar mandamos un código por SMS a tu celular terminado en ${hint}.`,
  phone: "Celular",
  phoneHint: "Con + y el código de país (+54 en Argentina).",
  phoneLocked: "El celular de la cuenta no se cambia desde acá. Si ya no tenés ese número, escribinos.",
  send: "Enviarme el código",
  sending: "Enviando…",
  code: "Código del SMS",
  verify: "Verificar",
  verifying: "Verificando…",
  resend: "Enviar otro código",
  resendIn: (seconds: number) => `Podés pedir otro código en ${seconds} s`,
  sent: (hint: string, minutes: number) => `Te mandamos un código al celular terminado en ${hint}. Vence en ${minutes} minutos.`,
  checking: "Revisando tu sesión…",
  contact: "Escribinos",
  signOut: "Salir",
  errors: {
    phone: (min: number, max: number) => `Escribí el celular con + y el código de país: entre ${min} y ${max} dígitos.`,
    code: (digits: number) => `El código tiene ${digits} dígitos.`,
    invalid: (left: number) => `El código no es correcto. Te ${left === 1 ? "queda 1 intento" : `quedan ${left} intentos`}.`,
    expired: "El código venció o ya no sirve. Pedí uno nuevo.",
    inUse: "Ese número ya está en uso en otra cuenta. Usá otro celular o escribinos.",
    sendFailed: "No pudimos mandar el SMS a ese número. En algunos países los SMS necesitan un registro previo; probá con otro celular o escribinos.",
    limit: (limit: SmsLimitName, minutes: number) =>
      limit === "RESEND"
        ? `Esperá ${minutes} min antes de pedir otro código.`
        : limit === "perAccount" || limit === "perNumber"
          ? "Llegaste al máximo de códigos por SMS de hoy para esta cuenta. Probá mañana o escribinos."
          : `Hay demasiados pedidos de código ahora. Probá de nuevo en ${minutes} min o escribinos.`,
    generic: "No pudimos completar el pedido. Probá de nuevo en unos minutos.",
  },
};

const EN = {
  enrolTitle: "Verify your mobile",
  enrolLead: "To use the demo, verify a mobile number of yours. We text you a code; every sign-in will ask for a new one.",
  signInTitle: "Enter the code we texted you",
  signInLead: (hint: string) => `To sign in we texted a code to your mobile ending in ${hint}.`,
  phone: "Mobile number",
  phoneHint: "With + and the country code (for example +54 for Argentina).",
  phoneLocked: "The account's mobile number is not changed here. If you no longer have it, write to us.",
  send: "Text me the code",
  sending: "Sending…",
  code: "Code from the SMS",
  verify: "Verify",
  verifying: "Verifying…",
  resend: "Send another code",
  resendIn: (seconds: number) => `You can ask for another code in ${seconds} s`,
  sent: (hint: string, minutes: number) => `We texted a code to your mobile ending in ${hint}. It expires in ${minutes} minutes.`,
  checking: "Checking your session…",
  contact: "Talk to us",
  signOut: "Sign out",
  errors: {
    phone: (min: number, max: number) => `Enter the mobile number with + and the country code: ${min} to ${max} digits.`,
    code: (digits: number) => `The code has ${digits} digits.`,
    invalid: (left: number) => `That code is not right. ${left === 1 ? "1 try left" : `${left} tries left`}.`,
    expired: "The code expired or no longer works. Ask for a new one.",
    inUse: "That number is already in use by another account. Use another mobile or write to us.",
    sendFailed: "We could not text that number. Some countries need a prior registration for SMS; try another mobile or write to us.",
    limit: (limit: SmsLimitName, minutes: number) =>
      limit === "RESEND"
        ? `Wait ${minutes} min before asking for another code.`
        : limit === "perAccount" || limit === "perNumber"
          ? "You reached today's maximum of SMS codes for this account. Try tomorrow or write to us."
          : `There are too many code requests right now. Try again in ${minutes} min or write to us.`,
    generic: "We could not complete the request. Try again in a few minutes.",
  },
} satisfies typeof ES;

export type PhoneCopy = typeof ES;

export const PHONE_COPY: Readonly<Record<Language, PhoneCopy>> = { es: ES, en: EN };
