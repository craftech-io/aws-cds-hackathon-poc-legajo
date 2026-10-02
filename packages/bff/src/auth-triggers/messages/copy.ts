// Texts of the account emails (ADR-0015 §7, docs/landing-spec.md §8.10), es and en with the same keys.
// Neutral: the product, the code and what to do; every message says "if you did not ask for it,
// ignore this message" and the footer names the brand, the synthetic data and the privacy policy.
// No role names, no links outside the demo's domain. The code and the user name are Cognito's own
// placeholders, replaced by Cognito (`{####}`, `{username}`), never a value of ours.
export type AccountEmailKind = "SIGNUP_CODE" | "FORGOT_PASSWORD" | "EXISTING_ACCOUNT" | "INVITATION" | "VERIFY_EMAIL";
export type EmailLang = "es" | "en";

export interface EmailText {
  readonly subject: string;
  readonly title: string;
  readonly lines: readonly string[];
  /** Label of the code box (`{####}`), or of the temporary password in an invitation. */
  readonly codeLabel: string;
  readonly note: string;
  /** Invitation only: label of the user name box and of the sign-in button. */
  readonly usernameLabel?: string;
  readonly action?: string;
}

export interface EmailChrome {
  readonly ignore: string;
  readonly footer: string;
  readonly privacy: string;
  readonly poweredBy: string;
  readonly fallback: string;
}

export const PRODUCT_NAME = "Legajo listo";

export const CHROME: Readonly<Record<EmailLang, EmailChrome>> = {
  es: {
    ignore: "Si no lo pediste, ignorá este mensaje.",
    footer: `${PRODUCT_NAME} · Powered by Craftech · datos 100 % sintéticos`,
    privacy: "Política de privacidad",
    poweredBy: "Powered by",
    fallback: "Si el botón no funciona, copiá este enlace en el navegador:",
  },
  en: {
    ignore: "If you did not ask for it, ignore this message.",
    footer: `${PRODUCT_NAME} · Powered by Craftech · 100% synthetic data`,
    privacy: "Privacy policy",
    poweredBy: "Powered by",
    fallback: "If the button does not work, copy this link into your browser:",
  },
};

export const TEXTS: Readonly<Record<EmailLang, Readonly<Record<AccountEmailKind, EmailText>>>> = {
  es: {
    SIGNUP_CODE: {
      subject: `Tu código para ${PRODUCT_NAME}`,
      title: "Confirmá tu email",
      lines: [`Usá este código para terminar de crear tu cuenta en <strong>${PRODUCT_NAME}</strong>.`],
      codeLabel: "Código",
      note: "El código vence en 24 horas.",
    },
    FORGOT_PASSWORD: {
      subject: `Cambiá tu contraseña de ${PRODUCT_NAME}`,
      title: "Cambiá tu contraseña",
      lines: [`Usá este código para elegir una contraseña nueva en <strong>${PRODUCT_NAME}</strong>.`],
      codeLabel: "Código",
      note: "El código vence en una hora. Si no lo pediste, tu contraseña no cambia.",
    },
    EXISTING_ACCOUNT: {
      subject: `Ya tenés una cuenta en ${PRODUCT_NAME}`,
      title: `Ya tenés una cuenta en ${PRODUCT_NAME}`,
      lines: ["Si fuiste vos, usá este código para entrar con la contraseña que acabás de elegir."],
      codeLabel: "Código",
      note: "El código vence en una hora. Si no lo pediste, tu contraseña no cambia.",
    },
    INVITATION: {
      subject: `Tu acceso a ${PRODUCT_NAME}`,
      title: `Te damos la bienvenida a ${PRODUCT_NAME}`,
      lines: [
        `Te invitaron a la consola de <strong>${PRODUCT_NAME}</strong>, el agente que reúne la factura comercial, el packing list y el certificado de origen de cada importación y deja el legajo listo para que el estudio lo apruebe.`,
        "Ingresá con tu usuario y la contraseña temporal; la primera vez vas a elegir una contraseña nueva.",
      ],
      codeLabel: "Contraseña temporal",
      usernameLabel: "Tu usuario",
      action: "Ingresar a la consola",
      note: "La contraseña temporal vence en 7 días.",
    },
    VERIFY_EMAIL: {
      subject: `${PRODUCT_NAME}: tu código de verificación`,
      title: "Tu código de verificación",
      lines: [`Usá este código para verificar tu email en <strong>${PRODUCT_NAME}</strong>.`],
      codeLabel: "Código",
      note: "El código vence en 24 horas.",
    },
  },
  en: {
    SIGNUP_CODE: {
      subject: `Your ${PRODUCT_NAME} code`,
      title: "Confirm your email",
      lines: [`Use this code to finish creating your <strong>${PRODUCT_NAME}</strong> account.`],
      codeLabel: "Code",
      note: "The code expires in 24 hours.",
    },
    FORGOT_PASSWORD: {
      subject: `Change your ${PRODUCT_NAME} password`,
      title: "Change your password",
      lines: [`Use this code to choose a new password in <strong>${PRODUCT_NAME}</strong>.`],
      codeLabel: "Code",
      note: "The code expires in one hour. If you did not ask for it, your password does not change.",
    },
    EXISTING_ACCOUNT: {
      subject: `You already have a ${PRODUCT_NAME} account`,
      title: `You already have a ${PRODUCT_NAME} account`,
      lines: ["If it was you, use this code to sign in with the password you just chose."],
      codeLabel: "Code",
      note: "The code expires in one hour. If you did not ask for it, your password does not change.",
    },
    INVITATION: {
      subject: `Your ${PRODUCT_NAME} access`,
      title: `Welcome to ${PRODUCT_NAME}`,
      lines: [
        `You were invited to the <strong>${PRODUCT_NAME}</strong> console, the agent that gathers the commercial invoice, the packing list and the certificate of origin of each import and gets the file ready for the firm to approve.`,
        "Sign in with your user name and the temporary password; the first time you will choose a new password.",
      ],
      codeLabel: "Temporary password",
      usernameLabel: "Your user name",
      action: "Sign in to the console",
      note: "The temporary password expires in 7 days.",
    },
    VERIFY_EMAIL: {
      subject: `${PRODUCT_NAME}: your verification code`,
      title: "Your verification code",
      lines: [`Use this code to verify your email in <strong>${PRODUCT_NAME}</strong>.`],
      codeLabel: "Code",
      note: "The code expires in 24 hours.",
    },
  },
};
