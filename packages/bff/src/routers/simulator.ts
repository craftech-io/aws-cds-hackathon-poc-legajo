// `simulator` router (docs/tool-catalog.md, docs/architecture-integrations.md §4.2, FL-083): the phone
// simulator of the console. It answers while `ChannelModes.whatsapp` is `simulated` and, in a `live`
// stage, in guest worlds, whose sends always take the simulator (outbound/routes.ts); any other world of
// a live stage gets `WHATSAPP_LIVE`. Only importers of the principal's firm. The console never sends a phone, a nonce or
// a `wamid`: the BFF builds the same signed SNS envelope a real WhatsApp event has from the importer's
// registered phone and hands it to `InboundWhatsApp` (channels/whatsapp/simulator.ts), so the message
// goes through the same gate, adapter and worker as a live one.
//
//   threads         the WhatsApp thread of every importer of the world, as the importer's phone shows it
//                   (templates rendered, buttons with their English gloss; never a nonce)
//   sendText        a text of the importer                        one `SIMULATOR_MESSAGES` of a guest world
//   tapButton       a tap on a button of one of our messages      one `SIMULATOR_MESSAGES`
//   attachDocument  a synthetic PDF of the operation's template (copied from `Seed`) or one the user
//                   uploaded with `presignMedia`                  one `SIMULATOR_MESSAGES` (+ one `PDF_UPLOADS`
//                                                                 for a synthetic one)
//   presignMedia    a presigned POST to `Media/sim/…` under the world's prefix, 1 byte to 10 MB, PDF only
//                                                                 one `PDF_UPLOADS`
//   markRead        "Marcar leído": `read` for every delivered message of the thread
import { z } from "zod";
import { DocType, ImporterId, OperationId, ToolError, WaButtonAction, mediaKeys, parseClockId, parseSimMediaKey, simMediaRef } from "@legajo/shared";
import { sendFromPhone, tapContent } from "../channels/whatsapp/simulator";
import { importerCounterpartKey } from "../connector/keys";
import { MAX_DOCUMENT_BYTES } from "../domain/documents";
import type { Importer } from "../domain/parties";
import { documentsPrefixOf } from "../intake/keys";
import { isGuestWorld } from "../outbound/recipient-fence";
import { ulid } from "../lib/crypto";
import { consoleServicesOf, consumeConsoleQuota } from "./console-services";
import { simulatorThreads } from "./simulator-threads";
import { type FirmContext, firmProcedure, router } from "./trpc";
import { WorldInput, worldOf } from "./world";

/** Refusal `reason` of every `simulator.*` procedure while WhatsApp runs live. */
export const LIVE_MODE_REASON = "WHATSAPP_LIVE";

const SendTextInput = z.object({ importerId: ImporterId, text: z.string().trim().min(1).max(1_000) }).strict();
const TapButtonInput = z.object({ importerId: ImporterId, messageId: z.string().min(1).max(64), action: WaButtonAction }).strict();
export const AttachSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SYNTHETIC"), operationId: OperationId, docType: DocType }).strict(),
  z.object({ kind: z.literal("UPLOAD"), key: z.string().min(1).max(512) }).strict(),
]);
const AttachDocumentInput = z.object({ importerId: ImporterId, source: AttachSource }).strict();
const PresignMediaInput = z.object({ importerId: ImporterId, filename: z.string().min(1).max(200), sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES) }).strict();
const MarkReadInput = z.object({ importerId: ImporterId }).strict();

/** The template PDFs of a model operation start at version 1 (docs/seed-spec.md). */
const SYNTHETIC_VERSION = 1;

function assertSimulated(ctx: FirmContext, clockId: string): void {
  if (ctx.deps.whatsappMode() !== "simulated" && !isGuestWorld(clockId)) throw new ToolError("CONFLICT", "the phone simulator is off while WhatsApp runs live", LIVE_MODE_REASON);
}

/** The importer the phone belongs to: of the principal's firm, in a world the simulator serves. */
async function phoneOf(ctx: FirmContext, importerId: string): Promise<Importer> {
  const importer = await ctx.deps.connector.parties.getImporter(importerId);
  await ctx.firmScope.assertFirm(importer.firmId);
  assertSimulated(ctx, importer.clockId);
  return importer;
}

/** `guest/<pub|res>/<firmId>/e<epoch>/` in a guest world, nothing in a demo world (intake/keys.ts). */
async function mediaPrefixOf(ctx: FirmContext, importer: Importer): Promise<string> {
  const [clock, firm] = await Promise.all([ctx.deps.connector.world.getClock(importer.clockId), ctx.deps.connector.firms.getFirm(importer.firmId)]);
  return documentsPrefixOf({ clockId: importer.clockId, firmId: importer.firmId, worldEpoch: clock.worldEpoch }, firm.guestKind);
}

/** A new `Media/sim/<id>/0.pdf` of the importer's world. */
async function newMediaKey(ctx: FirmContext, importer: Importer): Promise<string> {
  return `${await mediaPrefixOf(ctx, importer)}${mediaKeys.simulator(ulid(ctx.deps.wallClock().getTime()), 0)}`;
}

/** An uploaded key is accepted only under the importer's world prefix (a guest never names another world's object). */
async function uploadedKeyOf(ctx: FirmContext, importer: Importer, key: string): Promise<string> {
  const prefix = await mediaPrefixOf(ctx, importer);
  const parsed = parseSimMediaKey(key);
  const outsideWorld = prefix === "" ? parsed?.guest !== undefined || parsed?.qaRunId !== undefined : !key.startsWith(prefix);
  if (parsed === undefined || outsideWorld) throw new ToolError("INVALID", "that file was not uploaded from this simulator", "SIM_MEDIA_KEY");
  return key;
}

async function send(ctx: FirmContext, importer: Importer, action: Omit<Parameters<typeof sendFromPhone>[1], "phoneE164">) {
  await consumeConsoleQuota(ctx, importer.clockId, "SIMULATOR_MESSAGES");
  const { wamid } = await sendFromPhone(consoleServicesOf(ctx.deps).simulator.phone(), { ...action, phoneE164: importer.phoneE164 });
  ctx.log.info("simulator.sent", { importerId: importer.importerId, content: action.content.type });
  return { importerId: importer.importerId, wamid };
}

export const simulatorRouter = router({
  threads: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
    const clockId = await worldOf(ctx, input.clockId);
    assertSimulated(ctx, clockId);
    return { clockId, threads: await simulatorThreads(ctx.deps.connector, ctx.principal.firmId, clockId) };
  }),

  sendText: firmProcedure.input(SendTextInput).mutation(async ({ ctx, input }) => {
    const importer = await phoneOf(ctx, input.importerId);
    return send(ctx, importer, { content: { type: "text", text: input.text } });
  }),

  tapButton: firmProcedure.input(TapButtonInput).mutation(async ({ ctx, input }) => {
    const importer = await phoneOf(ctx, input.importerId);
    const thread = await ctx.deps.connector.conversations.listCounterpartMessages(importerCounterpartKey(importer.importerId), { direction: "OUT" });
    const message = thread.find((candidate) => candidate.messageId === input.messageId && candidate.channel === "WHATSAPP" && candidate.clockId === importer.clockId);
    const button = message?.buttons.find((candidate) => candidate.action === input.action);
    if (message === undefined || button === undefined) throw new ToolError("NOT_FOUND", "that message has no such button", "SIM_BUTTON_NOT_FOUND");
    if (button.nonce === undefined) throw new ToolError("INVALID", "that button opens a link and sends no reply", "SIM_BUTTON_OPENS_LINK");
    return send(ctx, importer, { content: tapContent(message, button), ...(message.providerMessageId === undefined ? {} : { contextWamid: message.providerMessageId }) });
  }),

  attachDocument: firmProcedure.input(AttachDocumentInput).mutation(async ({ ctx, input }) => {
    const importer = await phoneOf(ctx, input.importerId);
    const { source } = input;
    if (source.kind === "UPLOAD") return send(ctx, importer, { content: { type: "document", mediaRef: simMediaRef(await uploadedKeyOf(ctx, importer, source.key)) } });

    const operation = await ctx.deps.connector.operations.getOperation(source.operationId);
    await ctx.firmScope.assertFirm(operation.firmId);
    if (operation.importerId !== importer.importerId) throw new ToolError("INVALID", "that operation is not of this importer", "OPERATION_NOT_OF_IMPORTER");
    await consumeConsoleQuota(ctx, importer.clockId, "PDF_UPLOADS");
    const key = await newMediaKey(ctx, importer);
    await consoleServicesOf(ctx.deps).simulator.media.copySeedPdf({ templateOperation: operation.templateOperation, docType: source.docType, version: SYNTHETIC_VERSION, key });
    return send(ctx, importer, { content: { type: "document", mediaRef: simMediaRef(key), filename: `${source.docType.toLowerCase()}.pdf` } });
  }),

  presignMedia: firmProcedure.input(PresignMediaInput).mutation(async ({ ctx, input }) => {
    const importer = await phoneOf(ctx, input.importerId);
    if (parseClockId(importer.clockId)?.scope === "QA") throw new ToolError("INVALID", "a QA world uploads through its driver", "SIM_QA_WORLD");
    await consumeConsoleQuota(ctx, importer.clockId, "PDF_UPLOADS");
    const key = await newMediaKey(ctx, importer);
    const post = await consoleServicesOf(ctx.deps).simulator.media.presign(key);
    return { url: post.url, fields: post.fields, key };
  }),

  markRead: firmProcedure.input(MarkReadInput).mutation(async ({ ctx, input }) => {
    const importer = await phoneOf(ctx, input.importerId);
    const marked = await consoleServicesOf(ctx.deps).simulator.transport().markRead(importer.importerId);
    return { importerId: importer.importerId, marked };
  }),
});
