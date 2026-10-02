// The account emails `AuthCustomMessage` hands Cognito (ADR-0015 §7): inline HTML with tables (email
// clients drop <style> and SVG), a text wordmark that survives blocked images, the code in a box,
// "if you did not ask for it, ignore this message" and the footer with the privacy policy. Moved here
// from infra/auth-email.ts; the colors are the console's theme tokens (an email carries no stylesheet).
import { STAGE_DOMAIN } from "@legajo/shared";
import { LEGAL_PAGE_PATHS } from "@legajo/shared/legal-versions";
import { type AccountEmailKind, CHROME, type EmailLang, PRODUCT_NAME, TEXTS } from "./copy";

export type { AccountEmailKind, EmailLang };

/** Cognito's placeholders; the trigger receives them in `codeParameter` and `usernameParameter`. */
export const COGNITO_CODE = "{####}";
export const COGNITO_USERNAME = "{username}";
export const COGNITO_SUBJECT_MAX_CHARS = 140;
export const COGNITO_EMAIL_MAX_CHARS = 20_000;

const SITE = `https://${STAGE_DOMAIN}`;
export const LOGIN_URL = `${SITE}/login`;
export const PRIVACY_URL = `${SITE}${LEGAL_PAGE_PATHS.privacy}`;
/** PNG, because email clients do not render SVG (packages/web/public/brand). */
export const LOGO_URL = `${SITE}/brand/logo-craftech-color.png`;

/** Console theme tokens (packages/web/src/index.css `--color-*`). */
const C = { navy: "#0b1f3a", cyan: "#12b5d9", deep: "#0a7f99", ink: "#111a2b", slate: "#5a6a80", mist: "#e4e9f0", paper: "#f5f7fa", white: "#ffffff" } as const;
const SANS = "Inter,Segoe UI,Helvetica,Arial,sans-serif";
const MONO = "SFMono-Regular,Menlo,Consolas,monospace";
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

function paragraph(html: string, tone: "body" | "note" = "body"): string {
  const font = tone === "body" ? `400 15px/1.6 ${SANS}` : `400 13px/1.6 ${SANS}`;
  return `<p style="margin:0 0 14px;color:${tone === "body" ? C.ink : C.slate};font:${font};">${html}</p>`;
}

function row(padding: string, content: readonly string[]): string {
  return `<tr><td style="padding:${padding};">\n${content.join("\n")}\n</td></tr>`;
}

function field(label: string, value: string): string {
  return [
    `<p style="margin:0 0 4px;color:${C.slate};font:600 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;">${label}</p>`,
    `<p style="margin:0 0 14px;color:${C.navy};font:700 22px/1.4 ${MONO};letter-spacing:.12em;word-break:break-all;">${value}</p>`,
  ].join("\n");
}

function card(fields: readonly string[]): string {
  return row("4px 28px 12px", [`<table ${TABLE} width="100%" style="background:${C.paper};border:1px solid ${C.mist};border-radius:10px;"><tr><td style="padding:16px 18px 4px;">\n${fields.join("\n")}\n</td></tr></table>`]);
}

function button(href: string, label: string): string {
  const link = `<a href="${href}" style="display:inline-block;padding:14px 30px;color:${C.white};font:700 16px/1 ${SANS};text-decoration:none;border-radius:10px;">${label}</a>`;
  return `<tr><td align="center" style="padding:8px 28px 20px;"><table ${TABLE}><tr><td style="border-radius:10px;background:${C.deep};">${link}</td></tr></table></td></tr>`;
}

function footer(lang: EmailLang): string {
  const chrome = CHROME[lang];
  const logo = `<img src="${LOGO_URL}" alt="Craftech" height="20" style="display:block;height:20px;width:auto;border:0;color:${C.navy};font:700 13px/20px ${SANS};">`;
  const powered = `<table ${TABLE}><tr><td style="vertical-align:middle;padding-right:8px;color:${C.slate};font:400 12px/20px ${SANS};">${chrome.poweredBy}</td><td style="vertical-align:middle;">${logo}</td></tr></table>`;
  const line = `<p style="margin:0 0 10px;color:${C.slate};font:400 12px/1.5 ${SANS};">${chrome.footer} · <a href="${PRIVACY_URL}" style="color:${C.deep};">${chrome.privacy}</a></p>`;
  return `<tr><td style="border-top:1px solid ${C.mist};padding:18px 28px 22px;">\n${line}\n${powered}\n</td></tr>`;
}

function page(lang: EmailLang, title: string, rows: readonly string[]): string {
  const wordmark = `<span style="color:${C.white};font:700 20px/28px ${SANS};">Legajo <span style="color:${C.cyan};">listo</span></span>`;
  return [
    "<!doctype html>",
    `<html lang="${lang === "es" ? "es-AR" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.paper};">`,
    `<table ${TABLE} width="100%" style="background:${C.paper};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table ${TABLE} width="100%" style="max-width:560px;background:${C.white};border:1px solid ${C.mist};border-radius:12px;">`,
    `<tr><td style="background:${C.navy};padding:20px 28px;border-radius:12px 12px 0 0;">${wordmark}</td></tr>`,
    ...rows,
    footer(lang),
    "</table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("\n");
}

export interface AccountEmail {
  readonly subject: string;
  readonly message: string;
}

export interface Placeholders {
  /** `request.codeParameter` of the event (`{####}`). */
  readonly code: string;
  /** `request.usernameParameter` (`{username}`), only in an invitation. */
  readonly username?: string;
}

/** The email of `kind` in `lang`, with Cognito's own placeholders where the code and the user name go. */
export function accountEmail(kind: AccountEmailKind, lang: EmailLang, placeholders: Placeholders = { code: COGNITO_CODE }): AccountEmail {
  const text = TEXTS[lang][kind];
  const chrome = CHROME[lang];
  const fields = [...(kind === "INVITATION" && text.usernameLabel !== undefined ? [field(text.usernameLabel, placeholders.username ?? COGNITO_USERNAME)] : []), field(text.codeLabel, placeholders.code)];
  const rows = [
    row("28px 28px 8px", [`<h1 style="margin:0 0 14px;color:${C.navy};font:700 22px/1.3 ${SANS};">${text.title}</h1>`, ...text.lines.map((line) => paragraph(line))]),
    card(fields),
    ...(text.action === undefined ? [] : [button(LOGIN_URL, text.action)]),
    row("0 28px 12px", [
      paragraph(`${text.note} ${chrome.ignore}`, "note"),
      ...(text.action === undefined ? [] : [paragraph(`${chrome.fallback}<br><a href="${LOGIN_URL}" style="color:${C.deep};word-break:break-all;">${LOGIN_URL}</a>`, "note")]),
    ]),
  ];
  return { subject: text.subject, message: page(lang, `${PRODUCT_NAME}`, rows) };
}
