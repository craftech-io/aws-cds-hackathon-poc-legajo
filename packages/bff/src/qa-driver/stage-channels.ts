// The channel entries the `QaDriver` drives in the stage (docs/tool-catalog.md `wa.inbound`,
// `email.inject`, `email.redeliver`), always through the production paths:
//
//   wa.inbound       the phone simulator's signed SNS envelope to `InboundWhatsApp` (channels/whatsapp/
//                    simulator.ts), from the importer's registered phone, or from a phone leased for the
//                    world and registered to nobody (`UNREGISTERED`); a document is first a synthetic PDF
//                    of the operation's template copied to `Media` under the world's `qa/<runId>/`
//   email.inject     the single SES client with the profile `QA` (its fence checks the `From` and the
//                    recipient, channels/email/fence.ts); attachments are the template's synthetic PDFs
//   email.redeliver  `InboundEmail` invoked again with the receipt of a mail it already recorded (same SES
//                    message id, same S3 object): its idempotency marks must answer DUPLICATE
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { ToolError, mediaKeys, simMediaRef } from "@legajo/shared";
import { stageEmailClient } from "../channels/email/adapter";
import { type PhoneSimulatorDeps, sendFromPhone } from "../channels/whatsapp/simulator";
import type { SimulatedContent } from "../channels/whatsapp/sim-envelope";
import type { Connector } from "../connector/index";
import type { Message } from "../domain/conversations";
import { documentsPrefixOf } from "../intake/keys";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import type { Logger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { STAGE_REGION } from "../public-web/presign";
import type { SimulatorMedia } from "../routers/console-services";
import type { SeedPdfStore } from "../sim-mail/seed-pdfs";
import { CLONE_PHONES } from "../worlds/clones";
import type { ActionContext, ChannelsPort, EmailInjection, WhatsAppInbound } from "./ports";

export interface StageChannelsDeps {
  readonly data: Connector;
  readonly log: Logger;
  readonly phone: () => PhoneSimulatorDeps;
  readonly media: SimulatorMedia;
  readonly seedPdfs: () => SeedPdfStore;
  readonly email: () => Pick<ReturnType<typeof stageEmailClient>, "send">;
  /** `InboundEmail` invoked synchronously with a receipt event; answers its summary. */
  readonly inboundEmail: (event: unknown) => Promise<unknown>;
}

// ---- wa.inbound ------------------------------------------------------------------------------------

/** A phone of the QA block that no importer holds, leased for this world (the world's destroy releases it). */
async function unregisteredPhone(data: Connector, clockId: string, wamid: string, atReal: string): Promise<string> {
  const span = CLONE_PHONES.last - CLONE_PHONES.first + 1;
  const registered = new Set((await data.parties.listImporters("firm-qa", { clockId })).map((importer) => importer.phoneE164));
  const start = Number.parseInt(wamid.slice(-6), 16) % span;
  for (let offset = 0; offset < 40; offset += 1) {
    const phone = `${CLONE_PHONES.prefix}${String(CLONE_PHONES.first + ((start + offset) % span)).padStart(3, "0")}`;
    if (registered.has(phone)) continue;
    if (await data.world.acquireLease({ kind: "PHONE", value: phone, holder: clockId, atReal })) return phone;
    if ((await data.world.getLease("PHONE", phone))?.holder === clockId) return phone;
  }
  throw new ToolError("UNAVAILABLE", "no free phone of the QA block for an unregistered sender", "LEASES_EXHAUSTED");
}

async function contentOf(deps: StageChannelsDeps, operationId: string, wamid: string, message: WhatsAppInbound): Promise<{ readonly content: SimulatedContent; readonly contextWamid?: string }> {
  switch (message.type) {
    case "text":
      return { content: { type: "text", text: message.text } };
    case "media":
      return { content: { type: "media", mediaType: message.mediaType } };
    case "tap":
      return { content: message.content, ...(message.contextWamid === undefined ? {} : { contextWamid: message.contextWamid }) };
    case "document": {
      const operation = await deps.data.operations.getOperation(operationId);
      // The object's id derives from the message's own wamid: a retried step copies onto the same key.
      const key = `${documentsPrefixOf(operation, undefined)}${mediaKeys.simulator(wamid.replace(/[^A-Za-z0-9]/g, "").slice(-40), 0)}`;
      await deps.media.copySeedPdf({ templateOperation: message.templateOperation, docType: message.docType, version: message.version, key });
      return { content: { type: "document", mediaRef: simMediaRef(key), filename: `${message.docType.toLowerCase()}.pdf` } };
    }
  }
}

// ---- email.redeliver -------------------------------------------------------------------------------

/** The receipt `InboundEmail` got for a mail it recorded: its SES id, author, recipient and verdicts. */
export function redeliveryEvent(message: Pick<Message, "providerMessageId" | "from" | "to" | "subject" | "rfcMessageId" | "sentAtReal" | "trusted">): unknown {
  if (message.providerMessageId === undefined || message.to === undefined) throw new ToolError("NOT_FOUND", "the mail has no SES receipt to deliver again");
  const from = message.from ?? "";
  const headers = [{ name: "From", value: from }, { name: "To", value: message.to }, ...(message.rfcMessageId === undefined ? [] : [{ name: "Message-ID", value: message.rfcMessageId }])];
  return {
    Records: [
      {
        eventSource: "aws:ses",
        eventVersion: "1.0",
        ses: {
          mail: {
            timestamp: message.sentAtReal,
            source: from,
            messageId: message.providerMessageId,
            destination: [message.to],
            headersTruncated: false,
            headers,
            commonHeaders: { from: [from], to: [message.to], ...(message.rfcMessageId === undefined ? {} : { messageId: message.rfcMessageId }), ...(message.subject === undefined ? {} : { subject: message.subject }) },
          },
          receipt: {
            timestamp: message.sentAtReal,
            recipients: [message.to],
            spamVerdict: { status: "PASS" },
            virusVerdict: { status: "PASS" },
            dmarcVerdict: { status: message.trusted === true ? "PASS" : "FAIL" },
          },
        },
      },
    ],
  };
}

const INVOKE_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 60_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };
const RETRYABLE = new Set(["TooManyRequestsException", "ServiceException", "EC2ThrottledException"]);
const FunctionLink = z.object({ name: z.string().min(1) });

/** `lambda:Invoke` (request/response) of the linked `InboundEmail`. */
export function lambdaInboundEmail(client?: Pick<LambdaClient, "send">): (event: unknown) => Promise<unknown> {
  let lambda = client;
  return async (event) => {
    lambda ??= new LambdaClient({ region: STAGE_REGION, ...awsClientConfig(INVOKE_TIMEOUTS) });
    const send = lambda;
    const output = await withRetry(
      () => send.send(new InvokeCommand({ FunctionName: readLinked("InboundEmail", FunctionLink).name, InvocationType: "RequestResponse", Payload: new TextEncoder().encode(JSON.stringify(event)) })),
      { attempts: 3, baseDelayMs: 200, shouldRetry: (error) => RETRYABLE.has(error instanceof Error ? error.name : "") },
    );
    if (output.FunctionError !== undefined) throw new ToolError("UNAVAILABLE", `InboundEmail failed: ${output.FunctionError}`);
    const text = output.Payload === undefined ? "" : new TextDecoder().decode(output.Payload);
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  };
}

// ---- the port --------------------------------------------------------------------------------------

async function injectEmail(deps: StageChannelsDeps, input: EmailInjection, ctx: ActionContext): Promise<{ readonly sesMessageId: string }> {
  const clock = await deps.data.world.getClock(input.clockId);
  const pdfs = deps.seedPdfs();
  const attachments = await Promise.all(
    input.attachments.map(async (attachment) => ({ filename: `${attachment.docType.toLowerCase()}-v${attachment.version}.pdf`, bytes: new Uint8Array(await pdfs.read(attachment.templateOperation, attachment.docType, attachment.version)) })),
  );
  const sent = await deps.email().send({
    profile: "QA",
    from: { address: input.from },
    to: input.to,
    subject: input.subject,
    text: input.body,
    lang: "en",
    clockId: input.clockId,
    firmId: clock.firmId,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    kind: "QA_INJECT",
    mailId: input.mailId,
    actor: "QA",
    attachments,
    autoReply: input.autoReply,
  });
  if (sent.status === "REFUSED") throw new ToolError(sent.code, `the QA profile refused the mail (${sent.reason})`, sent.reason);
  ctx.log.info("qa_driver.email_injected", { clockId: input.clockId, mailId: input.mailId });
  return { sesMessageId: sent.providerMessageId };
}

export function stageChannels(deps: StageChannelsDeps): ChannelsPort {
  return {
    async whatsappInbound(input, ctx) {
      const operation = await deps.data.operations.getOperation(input.operationId);
      const phoneE164 = input.from === "IMPORTER" ? (await deps.data.parties.getImporter(operation.importerId)).phoneE164 : await unregisteredPhone(deps.data, input.clockId, input.wamid, ctx.now().toISOString());
      const { content, contextWamid } = await contentOf(deps, input.operationId, input.wamid, input.message);
      const { summary } = await sendFromPhone(deps.phone(), { phoneE164, content, wamid: input.wamid, ...(contextWamid === undefined ? {} : { contextWamid }) });
      const messageId = (summary as { messageId?: unknown } | undefined)?.messageId;
      return typeof messageId === "string" ? { messageId } : {};
    },
    injectEmail: (input, ctx) => injectEmail(deps, input, ctx),
    async redeliverEmail(input) {
      const message = await deps.data.conversations.getMessage(input.operationId, input.messageId);
      if (message === undefined || message.clockId !== input.clockId) throw new ToolError("NOT_FOUND", `no inbound email ${input.messageId} in ${input.clockId}`);
      const answer = (await deps.inboundEmail(redeliveryEvent(message))) as { outcome?: unknown; reason?: unknown } | undefined;
      return { redelivered: true, outcome: typeof answer?.outcome === "string" ? answer.outcome : null, reason: typeof answer?.reason === "string" ? answer.reason : null };
    },
  };
}
