// Our own headers on every outbound email (docs/architecture-integrations.md §1, "Encabezados propios"):
//
//   X-Legajo-Operation: 4471
//   X-Legajo-Request: kind=CORRECTION_REQUEST; docs=PACKING_LIST; obs=GROSS_WEIGHT_MISMATCH
//   X-Legajo-Mail-Id: <mailId>; clock=<clockId>            (channels/email/pending.ts)
//
// The request header is structured data of what we asked for. Only the supplier simulator reads it,
// and only after proving the mail is ours (DMARC, `From` and the `Message-ID` of a registered outbound
// message, docs/architecture-integrations.md §3); a real supplier ignores it.
import { z } from "zod";
import { DocType, MessageKind, ObservationCode, OperationNumber } from "@legajo/shared";

export const OPERATION_HEADER = "X-Legajo-Operation";
export const REQUEST_HEADER = "X-Legajo-Request";
export const AUTO_SUBMITTED_HEADER = "Auto-Submitted";

export const LegajoRequest = z
  .object({
    kind: MessageKind,
    docTypes: z.array(DocType).default([]),
    observationCodes: z.array(ObservationCode).default([]),
  })
  .strict();
export type LegajoRequest = z.infer<typeof LegajoRequest>;
export type LegajoRequestInput = z.input<typeof LegajoRequest>;

export function formatLegajoRequest(input: LegajoRequestInput): string {
  const request = LegajoRequest.parse(input);
  const parts = [`kind=${request.kind}`];
  if (request.docTypes.length > 0) parts.push(`docs=${request.docTypes.join(",")}`);
  if (request.observationCodes.length > 0) parts.push(`obs=${request.observationCodes.join(",")}`);
  return parts.join("; ");
}

/** Strict inverse of `formatLegajoRequest`: an unknown key or value makes the whole header unreadable. */
export function parseLegajoRequest(value: string | undefined): LegajoRequest | undefined {
  if (value === undefined) return undefined;
  const fields = new Map<string, string>();
  for (const part of value.split(";")) {
    const match = /^\s*(kind|docs|obs)=([A-Z_,]{1,400})\s*$/.exec(part);
    if (!match || fields.has(match[1] ?? "")) return undefined;
    fields.set(match[1] ?? "", match[2] ?? "");
  }
  const list = (key: string): string[] => (fields.get(key) ?? "").split(",").filter((item) => item !== "");
  const parsed = LegajoRequest.safeParse({ kind: fields.get("kind"), docTypes: list("docs"), observationCodes: list("obs") });
  return parsed.success ? parsed.data : undefined;
}

export function parseOperationHeader(value: string | undefined): OperationNumber | undefined {
  const parsed = OperationNumber.safeParse(value?.trim());
  return parsed.success ? parsed.data : undefined;
}

/**
 * RFC 3834: an automatic response announces itself with `Auto-Submitted` other than `no`. A missing
 * header or `no` is a human; anything else, including a malformed value, is treated as automatic.
 */
export function isAutoSubmitted(values: readonly string[]): boolean {
  return values.some((value) => value.trim().toLowerCase().split(";")[0]?.trim() !== "no");
}
