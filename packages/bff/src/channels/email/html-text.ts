// HTML body of an email to plain text, for mails without a `text/plain` part (docs/architecture-integrations.md
// §2, step 6). Hostile by assumption: `script`, `style`, `head` and every other non-rendered element
// go with their whole content, as do comments, nodes a reader never sees (`hidden`, `aria-hidden`,
// `display:none`, `visibility:hidden`, zero font size or opacity, zero height with hidden overflow)
// and quoted replies (`blockquote`, the usual quote containers). An element that never closes hides
// everything after it, and so does a tag this parser cannot read: dropping text is always safer than
// letting an invisible instruction through.
// The result is text only; the normalizer masks it, trims it and escapes it before anyone reads it.

/** Only the first 512 KB of markup are converted; the normalized text is capped far below that anyway. */
export const MAX_HTML_CHARS = 512 * 1024;

const DROPPED_ELEMENTS = new Set(["script", "style", "head", "title", "template", "noscript", "iframe", "object", "embed", "svg", "math", "select", "textarea", "button", "blockquote"]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea"]);
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "div", "dl", "dt", "dd", "fieldset", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "thead", "tfoot", "tr", "ul", "br",
]);
const QUOTE_CLASSES = /(?:^|\s)(?:gmail_quote|yahoo_quoted|moz-cite-prefix)(?:\s|$)/i;

// A tag never spans another "<" (not even inside a quoted value), so a hostile run of unclosed tags
// costs one linear pass instead of a quadratic backtrack. A quoted value may hold ">".
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^<>]*>|<\?[^<>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/g;
// What starts markup in text between tokens: a tag this parser could not read, so fail closed.
const UNREAD_MARKUP = /<[A-Za-z!/?]/;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ",
  uuml: "ü", Uuml: "Ü", iquest: "¿", iexcl: "¡", deg: "°", copy: "©", reg: "®", euro: "€",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[name] ?? whole;
  });
}

function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    if (name !== "" && !attributes.has(name)) attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

const ZERO_LENGTH = /^0(?:\.0+)?(?:px|pt|em|rem|%)?$/;

/** `style` declarations, lower case without spaces or `!important` (the last one of a property wins). */
function declarationsOf(style: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of style.toLowerCase().replace(/\s+/g, "").replace(/!important/g, "").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon > 0) declarations.set(declaration.slice(0, colon), declaration.slice(colon + 1));
  }
  return declarations;
}

function hiddenByStyle(style: string): boolean {
  const css = declarationsOf(style);
  const zero = (property: string): boolean => ZERO_LENGTH.test(css.get(property) ?? "");
  if (css.get("display") === "none") return true;
  if (css.get("visibility") === "hidden" || css.get("visibility") === "collapse") return true;
  if (zero("font-size") || zero("opacity")) return true;
  return (zero("height") || zero("max-height")) && css.get("overflow") === "hidden";
}

/** An element a reader of the rendered mail never sees, or a quote of an earlier message. */
function isHidden(tag: string, attributes: ReadonlyMap<string, string>): boolean {
  if (attributes.has("hidden")) return true;
  if ((attributes.get("aria-hidden") ?? "").trim().toLowerCase() === "true") return true;
  if (tag === "input" && (attributes.get("type") ?? "").toLowerCase() === "hidden") return true;
  if (QUOTE_CLASSES.test(attributes.get("class") ?? "")) return true;
  return hiddenByStyle(attributes.get("style") ?? "");
}

/** Converts the markup; whitespace is collapsed the way a browser renders it, blocks become lines. */
export function htmlToText(html: string): string {
  const source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const lowered = source.toLowerCase();
  const out: string[] = [];
  // Name of the element being skipped and how deep inside nested elements of the same name.
  let skipping: { tag: string; depth: number } | undefined;
  let cursor = 0;

  // A browser could have read a tag this parser could not (hidden or not): the text stops there.
  let unreadable = false;
  const emitText = (raw: string): void => {
    const cut = raw.search(UNREAD_MARKUP);
    if (cut !== -1) unreadable = true;
    const text = cut === -1 ? raw : raw.slice(0, cut);
    if (skipping || text === "") return;
    out.push(decodeEntities(text.replace(/[ \t\r\n\f]+/g, " ")));
  };

  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(source); match !== null && !unreadable; match = TOKEN.exec(source)) {
    emitText(source.slice(cursor, match.index));
    if (unreadable) break;
    cursor = match.index + match[0].length;
    const tag = match[1]?.toLowerCase();
    if (tag === undefined) continue; // comment, CDATA, doctype, processing instruction
    const closing = match[0].startsWith("</");

    if (skipping) {
      if (tag === skipping.tag && !VOID_ELEMENTS.has(tag)) skipping.depth += closing ? -1 : match[0].endsWith("/>") ? 0 : 1;
      if (skipping.depth === 0) skipping = undefined;
      continue;
    }
    if (closing) {
      if (BLOCK_ELEMENTS.has(tag) && tag !== "li") out.push("\n");
      else if (tag === "td" || tag === "th") out.push(" ");
      continue;
    }
    const attributes = attributesOf(match[2] ?? "");
    if (DROPPED_ELEMENTS.has(tag) || isHidden(tag, attributes)) {
      if (VOID_ELEMENTS.has(tag) || match[0].endsWith("/>")) continue;
      if (RAW_TEXT_ELEMENTS.has(tag)) {
        // Raw text may hold "<" freely: jump straight past its closing tag, or drop the rest.
        const end = lowered.indexOf(`</${tag}`, cursor);
        cursor = end === -1 ? source.length : source.indexOf(">", end) + 1 || source.length;
        TOKEN.lastIndex = cursor;
        continue;
      }
      skipping = { tag, depth: 1 };
      continue;
    }
    if (tag === "li") out.push("\n- ");
    else if (BLOCK_ELEMENTS.has(tag)) out.push("\n");
  }
  if (!unreadable) emitText(source.slice(cursor));

  return out
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
