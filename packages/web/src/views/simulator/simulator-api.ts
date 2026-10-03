// Edge of the phone simulator with the BFF (docs/tool-catalog.md, `simulator` router;
// docs/architecture-integrations.md §4.2). Every procedure answers only while `ChannelModes.whatsapp`
// is `simulated`; they are typed procedures of the `AppRouter`, and both directions are validated with zod.
// The BFF builds the same SNS envelope a real WhatsApp event has from the registered phone of the
// importer: the console never sends a phone, a nonce or a wamid, only the importer and what it did.
//
//   simulator.threads         {}                                   → { threads: SimThread[] }
//   simulator.sendText        { importerId, text }                 (routed to its operation by the BFF, as a real message)
//   simulator.tapButton       { importerId, messageId, action }     (the BFF resolves the button's nonce)
//   simulator.attachDocument  { importerId, source: SYNTHETIC { operationId, docType } | UPLOAD { key } }
//   simulator.presignMedia    { importerId, filename, sizeBytes }   → { url, fields, key } (POST to Media/sim/…)
//   simulator.markRead        { importerId }
import { DocType, ImporterId, IsoInstant, MessageDirection, MessageKind, OperationId, OperationNumber, WaButtonAction, WhatsAppTemplateName } from "@legajo/shared";
import { z } from "zod";
import { fetchWithRetry } from "../../lib/http";
import type { ConsoleClient } from "../../lib/trpc";

/** Refusal `reason` of every `simulator.*` procedure while WhatsApp runs live. */
export const LIVE_MODE_REASON = "WHATSAPP_LIVE";

/** A PDF of the simulator is at most 10 MB, like every upload of the demo. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Path of the public upload page every URL button of ours points at. */
const UPLOAD_PATH = "/u/";

/**
 * An upload link of ours: `/u/<token>` on the console's own origin (an `https` one when the origin is
 * unknown, as in Node), without credentials. Anything else (another host, `javascript:`, `data:`) is
 * never rendered as a link.
 */
export function isUploadLink(value: string, appOrigin: string | undefined = globalThis.location?.origin): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!url.pathname.startsWith(UPLOAD_PATH) || url.username !== "" || url.password !== "") return false;
  return appOrigin === undefined ? url.protocol === "https:" : url.origin === appOrigin;
}

export const SimButton = z.looseObject({
  action: WaButtonAction,
  title: z.string().min(1).max(25),
  /** The upload link of a template's URL button; dropped when it is not one of ours. */
  url: z
    .string()
    .nullish()
    .transform((url) => (url && isUploadLink(url) ? url : null)),
  glossEn: z.string().nullish(),
});
export type SimButton = z.infer<typeof SimButton>;

export const SimAttachment = z.looseObject({
  index: z.number().int().nonnegative(),
  status: z.enum(["ACCEPTED", "REJECTED", "QUARANTINED"]),
  sizeBytes: z.number().int().nonnegative().nullish(),
});

export const SimMessage = z.looseObject({
  messageId: z.string().min(1),
  direction: MessageDirection,
  operationNumber: OperationNumber.nullish(),
  kind: MessageKind.nullish(),
  /** Exactly what the importer's phone shows (a template already rendered with its parameters). */
  body: z.string(),
  template: WhatsAppTemplateName.nullish(),
  buttons: z.array(SimButton).default([]),
  attachments: z.array(SimAttachment).default([]),
  /** Delivery status (`SENT`, `DELIVERED`, `READ`, `DEFERRED`, …). */
  status: z.string().min(1),
  sentAtSim: IsoInstant,
  /** Fixed English gloss of a template or fixed text (copy/en-gloss.ts of the BFF); none for free text. */
  glossEn: z.string().nullish(),
});
export type SimMessage = z.infer<typeof SimMessage>;

export const SimThread = z.looseObject({
  importerId: ImporterId,
  importerName: z.string().min(1),
  contactName: z.string().min(1),
  phoneMasked: z.string().min(1),
  operations: z.array(z.looseObject({ operationId: OperationId, operationNumber: OperationNumber })).default([]),
  /** Outbound messages the importer has not read yet. */
  unread: z.number().int().nonnegative().default(0),
  /** A turn of the agent is running on one of the thread's operations. */
  typing: z.boolean().default(false),
  messages: z.array(SimMessage).default([]),
});
export type SimThread = z.infer<typeof SimThread>;

export const SimulatorThreads = z.looseObject({ threads: z.array(SimThread) });
export type SimulatorThreads = z.infer<typeof SimulatorThreads>;

export async function fetchThreads(trpc: ConsoleClient, signal?: AbortSignal): Promise<SimulatorThreads> {
  const raw = await trpc.simulator.threads.query({}, signal ? { signal } : undefined);
  return SimulatorThreads.parse(raw);
}

export const AttachSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SYNTHETIC"), operationId: OperationId, docType: DocType }).strict(),
  z.object({ kind: z.literal("UPLOAD"), key: z.string().min(1).max(512) }).strict(),
]);
export type AttachSource = z.infer<typeof AttachSource>;

const INPUTS = {
  sendText: z.object({ importerId: ImporterId, text: z.string().trim().min(1).max(1_000) }).strict(),
  tapButton: z.object({ importerId: ImporterId, messageId: z.string().min(1).max(64), action: WaButtonAction }).strict(),
  attachDocument: z.object({ importerId: ImporterId, source: AttachSource }).strict(),
  markRead: z.object({ importerId: ImporterId }).strict(),
} as const;

export type SimulatorAction = { readonly [K in keyof typeof INPUTS]: { readonly kind: K; readonly input: z.input<(typeof INPUTS)[K]> } }[keyof typeof INPUTS];

/** A validated action with the procedure it goes to. */
export type SimulatorRequest = { readonly [K in keyof typeof INPUTS]: { readonly kind: K; readonly path: `simulator.${K}`; readonly input: z.output<(typeof INPUTS)[K]> } }[keyof typeof INPUTS];

/** Procedure and validated input of an action of the phone; a malformed one throws before it is sent. */
export function actionRequest(action: SimulatorAction): SimulatorRequest {
  switch (action.kind) {
    case "sendText":
      return { kind: action.kind, path: "simulator.sendText", input: INPUTS.sendText.parse(action.input) };
    case "tapButton":
      return { kind: action.kind, path: "simulator.tapButton", input: INPUTS.tapButton.parse(action.input) };
    case "attachDocument":
      return { kind: action.kind, path: "simulator.attachDocument", input: INPUTS.attachDocument.parse(action.input) };
    case "markRead":
      return { kind: action.kind, path: "simulator.markRead", input: INPUTS.markRead.parse(action.input) };
  }
}

export function runSimulatorAction(trpc: ConsoleClient, action: SimulatorAction): Promise<unknown> {
  const request = actionRequest(action);
  switch (request.kind) {
    case "sendText":
      return trpc.simulator.sendText.mutate(request.input);
    case "tapButton":
      return trpc.simulator.tapButton.mutate(request.input);
    case "attachDocument":
      return trpc.simulator.attachDocument.mutate(request.input);
    case "markRead":
      return trpc.simulator.markRead.mutate(request.input);
  }
}

const PresignedPost = z.object({ url: z.string().url(), fields: z.record(z.string(), z.string()), key: z.string().min(1).max(512) });

/**
 * A PDF of the user's own: a presigned POST to `Media/sim/…` (exact key, `application/pdf`, 1 byte to
 * 10 MB, 5 minutes), then `attachDocument` with its key. The intake waits for the malware scan.
 */
export async function uploadOwnPdf(trpc: ConsoleClient, importerId: string, file: File): Promise<string> {
  const raw = await trpc.simulator.presignMedia.mutate({ importerId: ImporterId.parse(importerId), filename: file.name.slice(0, 200), sizeBytes: file.size });
  const post = PresignedPost.parse(raw);
  const form = new FormData();
  // The fields first, in order (they carry the key, the policy and `Content-Type`), the file last.
  for (const [name, value] of Object.entries(post.fields)) form.append(name, value);
  form.append("file", file);
  const response = await fetchWithRetry(post.url, { method: "POST", body: form }, { timeoutMs: 60_000 });
  if (!response.ok) throw new Error(`upload refused (${response.status})`);
  return post.key;
}
