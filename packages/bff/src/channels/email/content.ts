// Body of an outbound email as SES v2 `Content.Simple` takes it (docs/architecture-integrations.md §1):
// the subject, the text part exactly as the pipeline (or the simulator, or the `QaDriver`) wrote it,
// and an HTML part rendered from that same text, escaped, with nothing added. Links are never turned
// into anchors: the text is what was verified (`CP-NO-FOREIGN-LINKS`), and the HTML says no more.
import type { Message as SesMessage } from "@aws-sdk/client-sesv2";
import { PRODUCT_NAME } from "../../copy/helpers";
import { escapeUntrusted as escapeHtml } from "../normalizer";

/** What the text of an outbound email may hold; SES's own limit is far larger. */
export const MAX_OUTBOUND_TEXT_CHARS = 20_000;

/** Paragraphs on blank lines, `<br>` on single breaks, every character escaped. */
export function textToHtml(text: string, lang: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => `<p>${paragraph.split("\n").map(escapeHtml).join("<br>")}</p>`);
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><title>${escapeHtml(PRODUCT_NAME)}</title></head><body>${paragraphs.join("")}</body></html>`;
}

export interface EmailBody {
  readonly subject: string;
  readonly text: string;
  /** `en` to suppliers, `es` to the firm's mailbox (CLAUDE.md, "IDIOMAS"). */
  readonly lang: "en" | "es";
}

/** Subject and both parts in UTF-8; headers and attachments are added by the client. */
export function simpleContent(body: EmailBody): Pick<SesMessage, "Subject" | "Body"> {
  if (body.text.length > MAX_OUTBOUND_TEXT_CHARS) throw new RangeError(`an email body holds at most ${MAX_OUTBOUND_TEXT_CHARS} characters`);
  return {
    Subject: { Data: body.subject, Charset: "UTF-8" },
    Body: {
      Text: { Data: body.text, Charset: "UTF-8" },
      Html: { Data: textToHtml(body.text, body.lang), Charset: "UTF-8" },
    },
  };
}
