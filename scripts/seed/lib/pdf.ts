// Dependency-free PDF writer of the synthetic documents (docs/seed-spec.md §8), and the reader the
// validator uses on the same files. Output is PDF 1.4 text only: the standard Helvetica fonts in
// WinAnsi, A4 pages, a diagonal "SYNTHETIC" watermark and a footer on every page, an information
// dictionary with the `LegajoDocId` key and no creation or modification date, so the same input
// always gives the same bytes (and the same SHA-256 in the reader's catalog). Content streams are not
// compressed: the text of a page is its `Tj` strings, which `pdfTextLines` reads back.

export interface PdfLine {
  readonly text: string;
  readonly size?: number;
  readonly bold?: boolean;
  /** Extra space above the line, in points. */
  readonly gapBefore?: number;
  /** Indentation from the left margin, in points. */
  readonly indent?: number;
}

export interface PdfDocumentSpec {
  /** Information dictionary (`LegajoDocId`, `Title`, …); insertion order is kept. */
  readonly info: Readonly<Record<string, string>>;
  readonly lines: readonly PdfLine[];
  /** Printed diagonally, in light grey, on every page. */
  readonly watermark: string;
  /** Printed at the bottom of every page. */
  readonly footer: string;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_LEFT = 56;
const TOP_Y = 790;
const BOTTOM_Y = 72;
const DEFAULT_SIZE = 10;

// WinAnsiEncoding: Latin-1 above 0xA0 and a few code points of 0x80-0x9F.
const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = { "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97 };
const WIN_ANSI_BACK = new Map<number, string>(Object.entries(WIN_ANSI_EXTRA).map(([char, code]) => [code, char]));

function winAnsiBytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else if (WIN_ANSI_EXTRA[char] !== undefined) bytes.push(WIN_ANSI_EXTRA[char]);
    else throw new RangeError(`character U+${code.toString(16).toUpperCase()} has no WinAnsi code`);
  }
  return bytes;
}

/** A PDF literal string in pure ASCII: parentheses and backslash escaped, bytes above 0x7E in octal. */
export function pdfString(text: string): string {
  let out = "(";
  for (const byte of winAnsiBytes(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte > 0x7e) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

function pdfName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new RangeError(`invalid PDF name ${name}`);
  return `/${name}`;
}

/** Two decimals at most, no exponent: coordinates written the same way on every machine. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function textOp(line: PdfLine, y: number): string {
  const font = line.bold ? "/F2" : "/F1";
  return `BT ${font} ${num(line.size ?? DEFAULT_SIZE)} Tf ${num(MARGIN_LEFT + (line.indent ?? 0))} ${num(y)} Td ${pdfString(line.text)} Tj ET`;
}

function paginate(lines: readonly PdfLine[]): PdfLine[][] {
  const pages: PdfLine[][] = [[]];
  let y = TOP_Y;
  for (const line of lines) {
    const step = (line.size ?? DEFAULT_SIZE) + 4 + (line.gapBefore ?? 0);
    if (y - step < BOTTOM_Y) {
      pages.push([]);
      y = TOP_Y;
    }
    y -= step;
    pages.at(-1)?.push(line);
  }
  return pages;
}

function pageContent(lines: readonly PdfLine[], spec: PdfDocumentSpec, pageNo: number, pageCount: number): string {
  const ops: string[] = [];
  // Watermark: 45 degrees, light grey, drawn first so the text stays on top.
  ops.push(`q 0.85 g BT /F2 40 Tf 0.7071 0.7071 -0.7071 0.7071 150 230 Tm ${pdfString(spec.watermark)} Tj ET Q`);
  let y = TOP_Y;
  for (const line of lines) {
    y -= (line.size ?? DEFAULT_SIZE) + 4 + (line.gapBefore ?? 0);
    ops.push(textOp(line, y));
  }
  ops.push(textOp({ text: `${spec.footer} · Page ${pageNo} of ${pageCount}`, size: 8 }, 40));
  return `${ops.join("\n")}\n`;
}

/** The PDF bytes of `spec`; identical input, identical bytes. */
export function writePdf(spec: PdfDocumentSpec): Uint8Array {
  const pages = paginate(spec.lines);
  const objects: string[] = [];
  const pageRefs = pages.map((_, index) => 5 + index * 2);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((lines, index) => {
    const content = pageContent(lines, spec, index + 1, pages.length);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${index * 2 + 6} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  });
  const infoEntries = Object.entries(spec.info).map(([key, value]) => `${pdfName(key)} ${pdfString(value)}`);
  objects.push(`<< ${infoEntries.join(" ")} >>`);
  const infoRef = objects.length;

  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoRef} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

// ---- Reading back (the validator's side) ---------------------------------------------------------

function unescapeLiteral(body: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0));
      continue;
    }
    const next = body[index + 1] ?? "";
    const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1))?.[0];
    if (octal !== undefined) {
      bytes.push(parseInt(octal, 8));
      index += octal.length;
    } else {
      bytes.push(({ n: 10, r: 13, t: 9, b: 8, f: 12 } as Record<string, number>)[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return bytes.map((byte) => WIN_ANSI_BACK.get(byte) ?? String.fromCharCode(byte)).join("");
}

const LITERAL = "\\(((?:\\\\.|[^\\\\)])*)\\)";

/** Every string shown with `Tj`, in page order (watermarks and footers included). */
export function pdfTextLines(bytes: Uint8Array): string[] {
  const source = Buffer.from(bytes).toString("latin1");
  return [...source.matchAll(new RegExp(`${LITERAL}\\s*Tj`, "g"))].map((match) => unescapeLiteral(match[1] ?? ""));
}

/** The information dictionary the trailer points to. */
export function pdfInfo(bytes: Uint8Array): Record<string, string> {
  const source = Buffer.from(bytes).toString("latin1");
  const ref = /\/Info (\d+) 0 R/.exec(source.slice(source.lastIndexOf("trailer")))?.[1];
  const body = ref === undefined ? undefined : new RegExp(`(?:^|\\n)${ref} 0 obj\\n<<(.*?)>>\\nendobj`, "s").exec(source)?.[1];
  const info: Record<string, string> = {};
  for (const match of (body ?? "").matchAll(new RegExp(`/([A-Za-z][A-Za-z0-9]*) ${LITERAL}`, "g"))) info[match[1] ?? ""] = unescapeLiteral(match[2] ?? "");
  return info;
}

/** Pages of the file (`/Count` of the page tree). */
export function pdfPageCount(bytes: Uint8Array): number {
  return Number(/\/Type \/Pages [^>]*\/Count (\d+)/.exec(Buffer.from(bytes).toString("latin1"))?.[1] ?? 0);
}
