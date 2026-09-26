// Server-rendered HTML of `/u/<token>` (docs/design-brief.md §7): the operation number and the
// documents the link still asks for, one PDF input per document, "Listo" and the confirmation; and the
// error pages of an unusable link, which carry no data at all. Everything that varies is escaped; the
// only script and the only stylesheet are inline and allowed by hash, so the CSP needs neither
// `'unsafe-inline'` nor any third-party origin (docs/architecture.md §11).
import type { DocType } from "@legajo/shared";
import { PRODUCT_NAME } from "../copy/helpers";
import { MAX_DOCUMENT_BYTES } from "../domain/documents";
import { type ErrorPageKind, documentLabel, uploadPageEsAR } from "./copy";
import { UPLOAD_PAGE_SCRIPT, UPLOAD_PAGE_SCRIPT_HASH, cspHash } from "./page-script";

const texts = uploadPageEsAR;

// Palette of packages/web/src/index.css (the console's @theme); this page is not built by Vite.
export const UPLOAD_PAGE_STYLE = `
:root { --navy: #0b1f3a; --cyan: #12b5d9; --cyan-deep: #0a7f99; --ink: #111a2b; --slate: #5a6a80; --mist: #e4e9f0;
  --paper: #f5f7fa; --white: #ffffff; --success: #1d8f5a; --danger: #c73a52; color-scheme: light; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.bar { background: var(--navy); color: var(--white); padding: 14px 20px; font-weight: 600; }
main { max-width: 560px; margin: 24px auto; padding: 0 16px; }
.card { background: var(--white); border: 1px solid var(--mist); border-radius: 12px; padding: 24px; }
h1 { font-size: 1.5rem; margin: 0 0 8px; color: var(--navy); }
h2 { font-size: 1rem; margin: 24px 0 8px; color: var(--slate); text-transform: uppercase; letter-spacing: .04em; }
p { margin: 0 0 12px; }
ul { list-style: none; margin: 0; padding: 0; }
.doc { border: 1px solid var(--mist); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
.doc-name { font-weight: 600; display: block; margin-bottom: 8px; }
.pick { position: relative; display: inline-block; background: var(--cyan-deep); color: var(--white); border-radius: 8px; padding: 8px 14px; cursor: pointer; }
.pick:focus-within { outline: 2px solid var(--cyan); outline-offset: 2px; }
.pick input { position: absolute; opacity: 0; width: 1px; height: 1px; }
progress { display: block; width: 100%; margin-top: 8px; }
.status { margin: 8px 0 0; min-height: 1.5em; color: var(--slate); }
.doc[data-state="uploaded"] .status { color: var(--success); font-weight: 600; }
.doc[data-state="error"] .status { color: var(--danger); }
button { margin-top: 12px; width: 100%; border: 0; border-radius: 8px; padding: 12px; font-size: 1rem; font-weight: 600;
  background: var(--navy); color: var(--white); cursor: pointer; }
button:disabled { opacity: .45; cursor: not-allowed; }
.hint { color: var(--slate); font-size: .9rem; margin-top: 8px; }
.thanks { font-size: 1.25rem; text-transform: none; letter-spacing: 0; color: var(--success); }
#done-status { color: var(--danger); }
footer { text-align: center; color: var(--slate); font-size: .85rem; margin: 24px 0; }
`;

export const UPLOAD_PAGE_STYLE_HASH = cspHash(UPLOAD_PAGE_STYLE);

/** Content-Security-Policy of the page: its own script and style, and storage only at `uploadsOrigin`. */
export function uploadPageCsp(uploadsOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src ${UPLOAD_PAGE_SCRIPT_HASH}`,
    `style-src ${UPLOAD_PAGE_STYLE_HASH}`,
    "img-src 'self'",
    `connect-src 'self' ${uploadsOrigin}`,
    `form-action 'self' ${uploadsOrigin}`,
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The error pages have no script and nothing to reach. */
export function errorPageCsp(): string {
  return ["default-src 'none'", `style-src ${UPLOAD_PAGE_STYLE_HASH}`, "img-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function documentShell(title: string, body: string, script: boolean): string {
  return [
    "<!doctype html>",
    `<html lang="${texts.lang}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title>`,
    '<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">',
    `<style>${UPLOAD_PAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    `<header class="bar">${escapeHtml(PRODUCT_NAME)}</header>`,
    body,
    `<footer>${escapeHtml(texts.footer)}</footer>`,
    script ? `<script>${UPLOAD_PAGE_SCRIPT}</script>` : "",
    "</body>",
    "</html>",
  ].join("\n");
}

function documentItem(docType: DocType): string {
  const label = escapeHtml(documentLabel(docType));
  return [
    `<li class="doc" data-doc-type="${docType}" data-state="idle">`,
    `<span class="doc-name" id="doc-${docType}">${label}</span>`,
    `<label class="pick">${escapeHtml(texts.chooseFile)}<input type="file" accept="application/pdf,.pdf" aria-labelledby="doc-${docType}"></label>`,
    '<progress max="100" value="0" hidden></progress>',
    '<p class="status" role="status" aria-live="polite"></p>',
    "</li>",
  ].join("");
}

export interface UploadPageInput {
  readonly operationNumber: string;
  /** Documents the link still asks for, in its order. */
  readonly pending: readonly DocType[];
}

export function renderUploadPage(input: UploadPageInput): string {
  const scriptTexts = escapeHtml(JSON.stringify(texts.script));
  const body = [
    `<main id="upload" data-texts="${scriptTexts}" data-max-bytes="${MAX_DOCUMENT_BYTES}">`,
    '<div class="card">',
    `<h1>${escapeHtml(texts.heading(input.operationNumber))}</h1>`,
    '<section id="form">',
    `<p>${escapeHtml(texts.intro)}</p>`,
    `<h2>${escapeHtml(texts.listHeading)}</h2>`,
    `<ul>${input.pending.map(documentItem).join("")}</ul>`,
    `<button type="button" id="done" disabled>${escapeHtml(texts.doneButton)}</button>`,
    `<p class="hint">${escapeHtml(texts.doneHint)}</p>`,
    '<p id="done-status" role="alert"></p>',
    "</section>",
    '<section id="confirmation" tabindex="-1" hidden>',
    `<h2 class="thanks">${escapeHtml(texts.confirmationHeading)}</h2>`,
    `<p>${escapeHtml(texts.confirmationBody)}</p>`,
    '<p id="confirmation-pending"></p>',
    "</section>",
    "</div>",
    "</main>",
  ].join("\n");
  return documentShell(texts.title, body, true);
}

export function renderErrorPage(kind: ErrorPageKind): string {
  const page = texts.errors[kind];
  const body = ['<main><div class="card">', `<h1>${escapeHtml(page.title)}</h1>`, `<p>${escapeHtml(page.body)}</p>`, "</div></main>"].join("\n");
  return documentShell(`${page.title} · ${PRODUCT_NAME}`, body, false);
}
