// Pure half of the console's Cognito user pool (infra/auth.ts): the settings the pool and its web
// client are built from, the choice of email sender and the branded HTML emails Cognito sends (the
// invitation of AdminCreateUser and the code message ForgotPassword uses). No SST or Pulumi
// dependency, so infra/auth-email.test.ts checks every value without an AWS account, and
// scripts/console/invite.ts can read the groups, the tenant attribute and the password policy here.
//
// Email clients drop <style> blocks and SVG, so every rule is inline, the layout is tables and the
// only image is Craftech's PNG logo on an absolute URL of the app domain (packages/web/public/brand).
// Cognito replaces `{username}` (invitation only) and `{####}` (temporary password or code) and takes
// up to 20,000 characters per message and 140 per subject. Texts are Rioplatense Spanish, like the
// rest of the console (CLAUDE.md, "Idiomas").

/** The public brand is "Legajo listo · Powered by Craftech" (ADR-0006); no other name appears. */
export const PRODUCT_NAME = "Legajo listo";

// ---- Pool and web client -----------------------------------------------------------------------

/** Console roles, one Cognito group each; the lowest precedence wins in `cognito:preferred_role`. */
export const CONSOLE_GROUPS = {
  BROKER: { precedence: 10, description: "Customs broker: works, approves and reopens the dossiers of the firm" },
  GUEST: { precedence: 20, description: "Guest: broker permissions inside its own demo firm, no TOTP" },
  ANALYST: { precedence: 30, description: "Firm analyst: works the dossiers, never approves or reopens them" },
} as const;

export type ConsoleGroup = keyof typeof CONSOLE_GROUPS;

export const CONSOLE_GROUP_NAMES = Object.keys(CONSOLE_GROUPS) as ConsoleGroup[];

/** The tenant key: set by the invitation, readable by the web client, never writable by it. */
export const FIRM_ID_ATTRIBUTE = "firmId";
export const FIRM_ID_CLAIM = `custom:${FIRM_ID_ATTRIBUTE}`;

/** Also the rules the console checks before sending (packages/web/src/lib/auth/credentials.ts). */
export const PASSWORD_POLICY = {
  minimumLength: 12,
  requireLowercase: true,
  requireUppercase: true,
  requireNumbers: true,
  requireSymbols: true,
  temporaryPasswordValidityDays: 7,
} as const;

/** The only IAM actions the `Auth` link grants: the BFF reads whether a user has TOTP on. */
export const AUTH_LINK_ACTIONS = ["cognito-idp:AdminGetUser"] as const;

/** Build-time variables of the console, as packages/web/src/lib/env.ts reads them. */
export const WEB_ENV_NAMES = { userPoolId: "VITE_COGNITO_USER_POOL_ID", clientId: "VITE_COGNITO_CLIENT_ID" } as const;

type TokenUnit = "minutes" | "hours";

export interface WebClientSettings {
  generateSecret: boolean;
  allowedOauthFlowsUserPoolClient: boolean;
  allowedOauthFlows: string[];
  allowedOauthScopes: string[];
  callbackUrls: string[];
  logoutUrls: string[];
  supportedIdentityProviders: string[];
  explicitAuthFlows: string[];
  preventUserExistenceErrors: "ENABLED";
  enableTokenRevocation: boolean;
  accessTokenValidity: number;
  idTokenValidity: number;
  refreshTokenValidity: number;
  tokenValidityUnits: { accessToken: TokenUnit; idToken: TokenUnit; refreshToken: TokenUnit };
  readAttributes: string[];
  writeAttributes: string[];
}

// Public client of the browser: SRP and refresh only, no secret, no OAuth, no hosted UI (the
// placeholder callback URL SST puts on a client is cleared). Tokens live 15 minutes because the BFF
// verifies them offline, so a revoked or copied token is usable until it expires; the console
// refreshes silently with the 12-hour refresh token. Revocation also puts `origin_jti` on the
// tokens, which the BFF uses to tell two sessions on the same guest world apart.
export const WEB_CLIENT_SETTINGS: WebClientSettings = {
  generateSecret: false,
  allowedOauthFlowsUserPoolClient: false,
  allowedOauthFlows: [],
  allowedOauthScopes: [],
  callbackUrls: [],
  logoutUrls: [],
  supportedIdentityProviders: ["COGNITO"],
  explicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  preventUserExistenceErrors: "ENABLED",
  enableTokenRevocation: true,
  accessTokenValidity: 15,
  idTokenValidity: 15,
  refreshTokenValidity: 12,
  tokenValidityUnits: { accessToken: "minutes", idToken: "minutes", refreshToken: "hours" },
  readAttributes: ["email", "email_verified", "name", FIRM_ID_CLAIM],
  writeAttributes: ["name"],
};

export interface UserPoolSettings {
  userPoolTier: "ESSENTIALS";
  deletionProtection: "INACTIVE";
  adminCreateUserConfig: { allowAdminCreateUserOnly: boolean; inviteMessageTemplate: { emailSubject: string; emailMessage: string } };
  verificationMessageTemplate: { defaultEmailOption: "CONFIRM_WITH_CODE"; emailSubject: string; emailMessage: string };
  schemas: Array<{
    name: string;
    attributeDataType: "String";
    mutable: boolean;
    required: boolean;
    stringAttributeConstraints: { minLength: string; maxLength: string };
  }>;
  accountRecoverySetting: { recoveryMechanisms: Array<{ name: "verified_email"; priority: number }> };
  passwordPolicy: { -readonly [K in keyof typeof PASSWORD_POLICY]: (typeof PASSWORD_POLICY)[K] };
}

/**
 * What infra/auth.ts lays over SST's pool defaults. ESSENTIALS is the feature plan that runs the
 * pre token generation trigger V2_0 (free up to 10,000 monthly active users, nothing billed by the
 * hour). Only AdminCreateUser creates users; recovery goes only through the verified email.
 */
export function userPoolSettings(options: AuthEmailOptions): UserPoolSettings {
  const invitation = invitationEmail(options);
  const verification = verificationEmail(options);
  return {
    userPoolTier: "ESSENTIALS",
    // Removal is `remove` in every stage (CLAUDE.md).
    deletionProtection: "INACTIVE",
    adminCreateUserConfig: {
      allowAdminCreateUserOnly: true,
      inviteMessageTemplate: { emailSubject: invitation.subject, emailMessage: invitation.message },
    },
    verificationMessageTemplate: { defaultEmailOption: "CONFIRM_WITH_CODE", emailSubject: verification.subject, emailMessage: verification.message },
    schemas: [
      {
        name: FIRM_ID_ATTRIBUTE,
        attributeDataType: "String",
        mutable: true,
        required: false,
        stringAttributeConstraints: { minLength: "1", maxLength: "64" },
      },
    ],
    accountRecoverySetting: { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] },
    passwordPolicy: { ...PASSWORD_POLICY },
  };
}

// ---- Sender ------------------------------------------------------------------------------------

export const NO_REPLY_LOCAL_PART = "no-reply";

export interface EmailConfiguration {
  readonly emailSendingAccount: "DEVELOPER" | "COGNITO_DEFAULT";
  readonly sourceArn?: string;
  readonly fromEmailAddress?: string;
}

/** The SES identity as read on this deploy (infra/messaging-email.ts creates it). */
export interface SesIdentityState {
  readonly domain: string;
  readonly arn: string;
  readonly verified: boolean;
}

export interface EmailSenderChoice {
  readonly configuration: EmailConfiguration;
  /** Why Cognito keeps its own sender on this deploy; printed as a deploy warning. */
  readonly warning?: string;
}

/**
 * `Name <address>` for a From header. SES takes only printable ASCII there, and an RFC 5322 phrase
 * without specials needs no quoting, so anything else is refused instead of encoded.
 */
export function fromAddress(displayName: string, address: string): string {
  if (!/^[A-Za-z0-9 ]+$/.test(displayName) || displayName.trim() !== displayName) {
    throw new Error("the display name of a From header must be plain ASCII letters, digits and inner spaces");
  }
  if (!/^[a-z0-9-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(address)) throw new Error("the From address must be a lowercase ASCII mailbox");
  return `${displayName} <${address}>`;
}

/**
 * The sender of the console emails. SES (DEVELOPER) from `no-reply@<app domain>`, DKIM-aligned
 * under the domain's `p=reject` DMARC record, as soon as the identity exists and is verified;
 * Cognito's own sender, with the same templates, until then (DKIM can take a while after the
 * identity is created). An identity of another domain is a wiring error and fails the deploy.
 */
export function emailSenderFor(identity: SesIdentityState | undefined, appDomain: string): EmailSenderChoice {
  if (identity === undefined) {
    return {
      configuration: { emailSendingAccount: "COGNITO_DEFAULT" },
      warning: `infra/messaging-email.ts exports no emailIdentity yet: Cognito sends the console emails from its default sender until the SES identity ${appDomain} exists and is verified.`,
    };
  }
  if (identity.domain !== appDomain) throw new Error(`the SES identity is ${identity.domain}, but the console emails are sent from ${appDomain}`);
  if (!identity.verified) {
    return {
      configuration: { emailSendingAccount: "COGNITO_DEFAULT" },
      warning: `The SES identity ${appDomain} is not verified for sending yet: Cognito keeps its default sender until a deploy finds it verified.`,
    };
  }
  return {
    configuration: {
      emailSendingAccount: "DEVELOPER",
      sourceArn: identity.arn,
      fromEmailAddress: fromAddress(PRODUCT_NAME, `${NO_REPLY_LOCAL_PART}@${appDomain}`),
    },
  };
}

// ---- Emails ------------------------------------------------------------------------------------

export const COGNITO_USERNAME = "{username}";
export const COGNITO_CODE = "{####}";
export const COGNITO_EMAIL_MAX_CHARS = 20_000;
export const COGNITO_SUBJECT_MAX_CHARS = 140;

export const CRAFTECH_URL = "https://craftech.io";
/** PNG, because email clients do not render SVG (packages/web/public/brand). */
export const CRAFTECH_LOGO_FILE = "logo-craftech-color.png";
/** Sign-in route of the console (packages/web/src/routes.ts `LOGIN_PATH`). */
export const LOGIN_PATH = "/login";

export interface AuthEmailOptions {
  /** Absolute login URL of the console (`https://legajo.demo.craftech.io/login`). */
  readonly loginUrl: string;
  /** Absolute base of the brand files, without a trailing slash (`https://legajo.demo.craftech.io/brand`). */
  readonly brandUrl: string;
}

export interface CognitoEmail {
  readonly subject: string;
  readonly message: string;
}

/** Console theme tokens (packages/web/src/index.css `--color-*`); an email carries no stylesheet. */
export const EMAIL_PALETTE = {
  navy: "#0b1f3a",
  cyan: "#12b5d9",
  "cyan-deep": "#0a7f99",
  ink: "#111a2b",
  slate: "#5a6a80",
  mist: "#e4e9f0",
  paper: "#f5f7fa",
  white: "#ffffff",
} as const;

const C = EMAIL_PALETTE;
const SANS = "Inter,Segoe UI,Helvetica,Arial,sans-serif";
const MONO = "SFMono-Regular,Menlo,Consolas,monospace";
const LAYOUT_TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

function safeUrl(url: string): string {
  if (!/^https:\/\/[^\s"'<>]+$/.test(url)) throw new Error("email links must be absolute https URLs without quotes, spaces or angle brackets");
  return url;
}

function paragraph(html: string, tone: "body" | "note" = "body"): string {
  const font = tone === "body" ? `400 15px/1.6 ${SANS}` : `400 13px/1.6 ${SANS}`;
  return `<p style="margin:0 0 14px;color:${tone === "body" ? C.ink : C.slate};font:${font};">${html}</p>`;
}

function block(padding: string, content: readonly string[]): string {
  return `<tr><td style="padding:${padding};">\n${content.join("\n")}\n</td></tr>`;
}

function credential(label: string, value: string): string {
  return [
    `<p style="margin:0 0 4px;color:${C.slate};font:600 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;">${label}</p>`,
    `<p style="margin:0 0 14px;color:${C.navy};font:700 17px/1.4 ${MONO};word-break:break-all;">${value}</p>`,
  ].join("\n");
}

function credentialsCard(fields: readonly string[]): string {
  const card = `<table ${LAYOUT_TABLE} width="100%" style="background:${C.paper};border:1px solid ${C.mist};border-radius:10px;"><tr><td style="padding:16px 18px 4px;">\n${fields.join("\n")}\n</td></tr></table>`;
  return block("4px 28px 12px", [card]);
}

function actionButton(href: string, label: string): string {
  const link = `<a href="${href}" style="display:inline-block;padding:14px 30px;color:${C.white};font:700 16px/1 ${SANS};text-decoration:none;border-radius:10px;">${label}</a>`;
  return `<tr><td align="center" style="padding:8px 28px 20px;"><table ${LAYOUT_TABLE}><tr><td style="border-radius:10px;background:${C["cyan-deep"]};">${link}</td></tr></table></td></tr>`;
}

function fallbackLink(url: string): string {
  return paragraph(`Si el botón no funciona, copiá este enlace en el navegador:<br><a href="${url}" style="color:${C["cyan-deep"]};word-break:break-all;">${url}</a>`, "note");
}

function heading(title: string, lines: readonly string[]): string {
  return block("28px 28px 8px", [`<h1 style="margin:0 0 14px;color:${C.navy};font:700 22px/1.3 ${SANS};">${title}</h1>`, ...lines.map((line) => paragraph(line))]);
}

// The wordmark is text, like the console's (components/brand/Brand.tsx): it survives blocked images.
function brandHeader(): string {
  const wordmark = `<span style="color:${C.white};font:700 20px/28px ${SANS};">Legajo <span style="color:${C.cyan};">listo</span></span>`;
  return `<tr><td style="background:${C.navy};padding:20px 28px;border-radius:12px 12px 0 0;">${wordmark}</td></tr>`;
}

function brandFooter(brandUrl: string): string {
  const logo = `<img src="${brandUrl}/${CRAFTECH_LOGO_FILE}" alt="Craftech" height="20" style="display:block;height:20px;width:auto;border:0;color:${C.navy};font:700 13px/20px ${SANS};">`;
  const poweredBy = `<table ${LAYOUT_TABLE}><tr><td style="vertical-align:middle;padding-right:8px;color:${C.slate};font:400 12px/20px ${SANS};">Powered by</td><td style="vertical-align:middle;"><a href="${CRAFTECH_URL}" style="text-decoration:none;">${logo}</a></td></tr></table>`;
  const demo = `<p style="margin:0 0 10px;color:${C.slate};font:400 12px/1.5 ${SANS};">${PRODUCT_NAME} es una demo con datos sintéticos: estudios, importadores y proveedores son ficticios.</p>`;
  return `<tr><td style="border-top:1px solid ${C.mist};padding:18px 28px 22px;">\n${demo}\n${poweredBy}\n</td></tr>`;
}

function layout(title: string, rows: readonly string[], brandUrl: string): string {
  return [
    "<!doctype html>",
    `<html lang="es-AR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.paper};">`,
    `<table ${LAYOUT_TABLE} width="100%" style="background:${C.paper};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table ${LAYOUT_TABLE} width="100%" style="max-width:560px;background:${C.white};border:1px solid ${C.mist};border-radius:12px;">`,
    brandHeader(),
    ...rows,
    brandFooter(brandUrl),
    "</table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("\n");
}

/** Invitation of AdminCreateUser (`npm run console:invite`): username, temporary password, first steps. */
export function invitationEmail(options: AuthEmailOptions): CognitoEmail {
  const loginUrl = safeUrl(options.loginUrl);
  const brandUrl = safeUrl(options.brandUrl);
  const steps = [
    "Ingresá con este email (o con tu usuario) y la contraseña temporal.",
    `Elegí una contraseña nueva: al menos ${PASSWORD_POLICY.minimumLength} caracteres, con mayúscula, minúscula, número y símbolo.`,
    "Si querés, activá el código de verificación (TOTP) con una app de autenticación como Google Authenticator o Microsoft Authenticator. Es opcional y suma una capa de seguridad.",
  ];
  const rows = [
    heading(`Te damos la bienvenida a ${PRODUCT_NAME}`, [
      `Te invitaron a la consola de <strong>${PRODUCT_NAME}</strong>, el agente que reúne la factura comercial, el packing list y el certificado de origen de cada importación y deja el legajo listo para que el estudio lo apruebe.`,
      "Estos son tus datos para el primer ingreso:",
    ]),
    credentialsCard([credential("Tu usuario", COGNITO_USERNAME), credential("Contraseña temporal", COGNITO_CODE)]),
    actionButton(loginUrl, "Ingresar a la consola"),
    block("0 28px 12px", [
      paragraph("<strong>La primera vez:</strong>"),
      `<ol style="margin:0 0 14px;padding-left:20px;color:${C.ink};font:400 14px/1.6 ${SANS};">`,
      ...steps.map((step) => `<li style="margin:0 0 6px;">${step}</li>`),
      "</ol>",
      paragraph(
        `La contraseña temporal vence en ${PASSWORD_POLICY.temporaryPasswordValidityDays} días. Si vence, pedí una invitación nueva a quien te invitó. Si no esperabas esta invitación, ignorá este correo.`,
        "note",
      ),
      fallbackLink(loginUrl),
    ]),
  ];
  return { subject: `Tu acceso a la consola de ${PRODUCT_NAME}`, message: layout(`Invitación a ${PRODUCT_NAME}`, rows, brandUrl) };
}

/** The code message: "Olvidé mi contraseña" (ForgotPassword) and any email verification. */
export function verificationEmail(options: AuthEmailOptions): CognitoEmail {
  const loginUrl = safeUrl(options.loginUrl);
  const brandUrl = safeUrl(options.brandUrl);
  const rows = [
    heading("Tu código de verificación", [
      `Usá este código en la consola de <strong>${PRODUCT_NAME}</strong>. Si pediste restablecer tu contraseña, ingresalo junto con la contraseña nueva.`,
    ]),
    credentialsCard([credential("Código", COGNITO_CODE)]),
    actionButton(loginUrl, "Ir a la consola"),
    block("0 28px 12px", [paragraph("El código vence en una hora. Si no lo pediste, ignorá este correo: tu contraseña no cambió.", "note"), fallbackLink(loginUrl)]),
  ];
  return { subject: `${PRODUCT_NAME}: tu código de verificación`, message: layout(`Código de ${PRODUCT_NAME}`, rows, brandUrl) };
}
