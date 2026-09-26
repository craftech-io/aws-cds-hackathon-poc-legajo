// Bounded lookup of the `LegajoDocId` info key of a PDF (docs/architecture-integrations.md §5,
// point 2), the second way the mock finds the ground truth of a synthetic document when its SHA-256
// is not in the catalog. The parser is a maintained one (PDF.js through `unpdf`, which never runs a
// PDF's scripts; XFA, fonts and WebAssembly decoders off), and it only runs on files under the byte
// cap, with a `%PDF-` header and under the object cap, and only for as long as the time cap. Any
// error, cap or malformed id is "no id": the caller answers UNRECOGNIZED. Nothing else of the PDF
// (title, text, other keys) is read.
import { getResolvedPDFJS } from "unpdf";
import { SyntheticDocId } from "@legajo/shared";
import { READER_LIMITS } from "@legajo/reader-contract";

export const PDF_PARSER_LIMITS = {
  maxBytes: READER_LIMITS.maxFileBytes,
  /** Indirect objects counted in the raw bytes before parsing; the synthetic PDFs have a few dozen. */
  maxObjects: 5_000,
  timeoutMs: 3_000,
} as const;

export interface PdfParserLimits {
  readonly maxBytes: number;
  readonly maxObjects: number;
  readonly timeoutMs: number;
}

export const DOC_ID_INFO_KEY = "LegajoDocId";

const HEADER = "%PDF-";
const HEADER_WINDOW = 1_024;
const OBJECT_HEADER = /(?<![\d])\d{1,10}[ \t\r\n]+\d{1,5}[ \t\r\n]+obj\b/g;

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** Indirect objects (`n g obj`) in the raw bytes, counting up to `cap + 1`. */
export function countIndirectObjects(bytes: Uint8Array, cap: number): number {
  let count = 0;
  for (const _match of latin1(bytes).matchAll(OBJECT_HEADER)) {
    count += 1;
    if (count > cap) break;
  }
  return count;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return latin1(bytes.subarray(0, HEADER_WINDOW)).includes(HEADER);
}

function customInfoValue(info: unknown, key: string): unknown {
  if (typeof info !== "object" || info === null) return undefined;
  const custom: unknown = Reflect.get(info, "Custom");
  return typeof custom === "object" && custom !== null ? Reflect.get(custom, key) : undefined;
}

function expiresIn<T>(timeoutMs: number, onTimeout: () => void): { promise: Promise<T>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`PDF parse exceeded ${timeoutMs} ms`));
    }, timeoutMs);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** The `LegajoDocId` of a synthetic PDF, or undefined for anything else. */
export async function embeddedDocId(bytes: Uint8Array, limits: PdfParserLimits = PDF_PARSER_LIMITS): Promise<SyntheticDocId | undefined> {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxBytes || !hasPdfHeader(bytes)) return undefined;
  if (countIndirectObjects(bytes, limits.maxObjects) > limits.maxObjects) return undefined;
  const pdfjs = await getResolvedPDFJS();
  // PDF.js takes ownership of the buffer it parses, so it gets a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    stopAtErrors: true,
    enableXfa: false,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
    isOffscreenCanvasSupported: false,
  });
  const deadline = expiresIn<never>(limits.timeoutMs, () => void task.destroy().catch(() => undefined));
  try {
    const document = await Promise.race([task.promise, deadline.promise]);
    const metadata = await Promise.race([document.getMetadata(), deadline.promise]);
    const parsed = SyntheticDocId.safeParse(customInfoValue(metadata.info, DOC_ID_INFO_KEY));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    deadline.cancel();
    await task.destroy().catch(() => undefined);
  }
}
