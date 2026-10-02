// The single SES v2 client of the stage (docs/architecture-integrations.md §1). Every email the
// system sends goes through `send`: the outbound pipeline and the escalations (profile `SYSTEM`), the
// supplier simulator (`SIMULATOR`) and the `QaDriver`'s `email.inject` (`QA`). In order:
//
//   1. the request is validated (zod, strict) and every header value built from data is checked
//      (no CR/LF or control characters; non-ASCII display names RFC 2047-encoded);
//   2. the recipient fence of the declared profile runs (channels/email/fence.ts); a refusal returns
//      `RECIPIENT_NOT_ALLOWED` or `INVALID` before SES is called, and is audited (`CP-RECIPIENT-FENCE`);
//   3. the pending mail `Runtime/PENDING#<clockId>` · `MAIL#<mailId>` is written, naming who closes it;
//   4. `SendEmail` with `Content.Simple` (text and HTML), our headers (`X-Legajo-*`, `In-Reply-To`,
//      `References`, `Auto-Submitted`), the profile's configuration set and `EmailTags`; attachments
//      only for the simulator and QA (the agent never forwards a document, `LAM-ATTACHMENT`);
//   5. if SES refuses or the call fails, the pending item is closed with `SEND_FAILED` so the world
//      does not wait for a mail that never left.
//
// It returns the SES message id (`providerMessageId`); the caller persists its own `Message OUT`.
//
// `LEAD_NOTICE` (the internal notice of a new lead, ADR-0015 §6) is the one profile without a clock:
// fence (exact `@craftech.io`), checked headers and `SendEmail`, but no pending mail, no
// `X-Legajo-Mail-Id`, no audit row and no `Message` to record; its state is `Leads/LEAD.noticeStatus`.
// Every other profile needs its `clockId` and is refused (`INVALID`) without one.
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { z } from "zod";
import { ChannelError, ClockId, FirmId, MessageId, OperationId, OperationNumber, type MailAwaiting, type SenderProfile } from "@legajo/shared";
import type { AuditPort, RuntimePort, WorldPort } from "../../connector/ports-runtime";
import { Actor } from "../../domain/common";
import { awsClientConfig } from "../../lib/clients";
import type { Logger } from "../../lib/log";
import { type ChannelTransport, countMetric } from "../adapter";
import { assertHeaderValue, formatMailbox, parseMessageIds, sesRfcMessageId } from "./address";
import { EMAIL_METRICS, INBOUND_REASONS, PDF_CONTENT_TYPE, SES_REGION, SES_TIMEOUTS } from "./config";
import { MAX_OUTBOUND_TEXT_CHARS, simpleContent } from "./content";
import { type FenceDecision, type FenceDeps, type FenceIntent, type SimulatorPurpose, checkFence } from "./fence";
import { AUTO_SUBMITTED_HEADER, LegajoRequest, OPERATION_HEADER, REQUEST_HEADER, formatLegajoRequest } from "./headers";
import { MAIL_ID_HEADER, MAIL_ID_PATTERN, closeMailPending, mailIdHeaderValue } from "./pending";
import { startsWithPdfMagic } from "./mime";

const MessageIdHeader = z.string().regex(/^<[^<>\s@]{1,250}@[^<>\s@]{1,250}>$/, "expected <id@domain>");
const TagValue = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, "an EmailTags value holds letters, digits, '_' and '-'");

const Attachment = z.object({ filename: z.string().regex(/^[A-Za-z0-9._-]{1,100}\.pdf$/), bytes: z.instanceof(Uint8Array) }).strict();

const SendBase = z.object({
  from: z.object({ address: z.string(), displayName: z.string().min(1).max(200).optional() }).strict(),
  to: z.string(),
  /** Only ever the `From` address itself (the thread address of a supplier email). */
  replyTo: z.string().optional(),
  subject: z.string().min(1).max(400),
  text: z.string().min(1).max(MAX_OUTBOUND_TEXT_CHARS),
  lang: z.enum(["en", "es"]),
  inReplyTo: MessageIdHeader.optional(),
  references: z.array(MessageIdHeader).max(50).default([]),
  request: LegajoRequest.optional(),
  operationNumber: OperationNumber.optional(),
  clockId: ClockId,
  firmId: FirmId,
  operationId: OperationId.optional(),
  /** The `Message OUT` the caller will record, for `EmailTags`. */
  messageId: MessageId.optional(),
  /** `EmailTags.kind`: the `MessageKind`, or what the simulator or QA sends (`SIM_REPLY`, `QA_INJECT`). */
  kind: TagValue,
  /** The `QaDriver` derives it from the step's key; everyone else gets a new ULID. */
  mailId: z.string().regex(MAIL_ID_PATTERN).optional(),
  actor: Actor.optional(),
});

const SimulatorPurposeSchema: z.ZodType<SimulatorPurpose> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("REPLY"), answered: z.object({ from: z.string(), to: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal("SEND_NOW"), operationId: OperationId }).strict(),
]);

const LeadNoticeRequest = z
  .object({
    profile: z.literal("LEAD_NOTICE"),
    from: z.object({ address: z.string(), displayName: z.string().min(1).max(200).optional() }).strict(),
    to: z.string(),
    subject: z.string().min(1).max(400),
    text: z.string().min(1).max(MAX_OUTBOUND_TEXT_CHARS),
    lang: z.enum(["en", "es"]),
    kind: TagValue,
  })
  .strict();

export const EmailSendRequest = z.discriminatedUnion("profile", [
  LeadNoticeRequest,
  SendBase.extend({ profile: z.literal("SYSTEM") }).strict(),
  SendBase.extend({ profile: z.literal("SIMULATOR"), purpose: SimulatorPurposeSchema, attachments: z.array(Attachment).max(5).default([]), autoReply: z.boolean().default(false) }).strict(),
  SendBase.extend({ profile: z.literal("QA"), attachments: z.array(Attachment).max(5).default([]), autoReply: z.boolean().default(false) }).strict(),
]);
export type EmailSendRequest = z.input<typeof EmailSendRequest>;
type ParsedRequest = Exclude<z.output<typeof EmailSendRequest>, { profile: "LEAD_NOTICE" }>;
type ParsedLeadNotice = z.output<typeof LeadNoticeRequest>;

export type EmailSendResult =
  | {
      readonly status: "SENT";
      readonly providerMessageId: string;
      readonly rfcMessageId: string;
      /** Absent for `LEAD_NOTICE`, which has no pending mail. */
      readonly mailId?: string;
      readonly awaiting: MailAwaiting;
      readonly from: string;
      readonly to: string;
    }
  | { readonly status: "REFUSED"; readonly code: "INVALID" | "RECIPIENT_NOT_ALLOWED"; readonly reason: string };

export interface EmailClient extends ChannelTransport<EmailSendRequest, EmailSendResult> {
  /** The fence alone, in test mode (`fence.probe` of the `QaDriver`): never writes, never sends. */
  checkRecipient(intent: FenceIntent): Promise<FenceDecision>;
}

export interface EmailClientDeps {
  readonly fence: FenceDeps;
  readonly world: Pick<WorldPort, "putMailPending" | "getMailPending" | "closeMailPending">;
  readonly runtime: Pick<RuntimePort, "putMailProbe">;
  readonly audit: Pick<AuditPort, "record">;
  /** Configuration set of each profile (`Resource.EmailSender<Profile>.configurationSet`). */
  readonly configurationSet: (profile: SenderProfile) => string;
  /** Stage name, for `EmailTags`. */
  readonly stage: string;
  /** Real clock (stamps of the pending item and the audit row). */
  readonly now: () => Date;
  readonly newMailId: () => string;
  readonly log: Logger;
  readonly ses?: SESv2Client;
}

function intentOf(request: ParsedRequest): FenceIntent {
  if (request.profile === "SIMULATOR") return { profile: "SIMULATOR", from: request.from.address, to: request.to, purpose: request.purpose };
  if (request.profile === "SYSTEM") return { profile: "SYSTEM", from: request.from.address, to: request.to, clockId: request.clockId, ...(request.operationId === undefined ? {} : { operationId: request.operationId }) };
  return { profile: "QA", from: request.from.address, to: request.to };
}

function defaultActor(profile: SenderProfile): Actor {
  return profile === "QA" ? "QA" : "SYSTEM";
}

/** Every header value that comes from data, checked; a bad one refuses the send (`INVALID`). */
function headersOf(request: ParsedRequest, mailId: string): Array<{ Name: string; Value: string }> {
  const headers: Array<[string, string]> = [[MAIL_ID_HEADER, mailIdHeaderValue({ mailId, clockId: request.clockId })]];
  if (request.operationNumber !== undefined) headers.push([OPERATION_HEADER, request.operationNumber]);
  if (request.request !== undefined) headers.push([REQUEST_HEADER, formatLegajoRequest(request.request)]);
  if (request.inReplyTo !== undefined) headers.push(["In-Reply-To", request.inReplyTo]);
  if (request.references.length > 0) headers.push(["References", parseMessageIds(request.references.join(" ")).join(" ")]);
  if (request.profile !== "SYSTEM" && request.autoReply) headers.push([AUTO_SUBMITTED_HEADER, "auto-replied"]);
  return headers.map(([name, value]) => ({ Name: name, Value: assertHeaderValue(name, value) }));
}

function tagsOf(request: ParsedRequest, stage: string, mailId: string): Array<{ Name: string; Value: string }> {
  const tags: Array<[string, string | undefined]> = [
    ["stage", stage],
    ["kind", request.kind],
    ["mailId", mailId],
    ["operationId", request.operationId],
    ["messageId", request.messageId],
  ];
  return tags.flatMap(([name, value]) => (value === undefined ? [] : [{ Name: name, Value: TagValue.parse(value) }]));
}

function sesError(error: unknown): ChannelError {
  const name = error instanceof Error ? error.name : "";
  if (name === "TooManyRequestsException" || name === "LimitExceededException") return new ChannelError("RATE_LIMITED", "EMAIL", "SES throttled the send", { cause: error });
  if (name === "TimeoutError" || name === "AbortError" || name === "RequestTimeout") return new ChannelError("TIMEOUT", "EMAIL", "SES did not answer in time", { cause: error });
  if (/Rejected|NotVerified|Suspended|Paused|BadRequest|NotFound/.test(name)) return new ChannelError("SEND_FAILED", "EMAIL", `SES refused the send (${name})`, { cause: error, retryable: false });
  return new ChannelError("UNAVAILABLE", "EMAIL", "SES send failed", { cause: error, retryable: true });
}

export function createEmailClient(deps: EmailClientDeps): EmailClient {
  let client = deps.ses;
  const ses = (): SESv2Client => (client ??= new SESv2Client({ region: SES_REGION, ...awsClientConfig(SES_TIMEOUTS) }));

  /** A refusal before SES: the fence's (`CP-RECIPIENT-FENCE`) or a malformed request's (headers, Reply-To, attachments). */
  async function refuse(request: ParsedRequest, code: "INVALID" | "RECIPIENT_NOT_ALLOWED", reason: string, fence = false): Promise<EmailSendResult> {
    await deps.audit.record({
      firmId: request.firmId,
      decision: "DENY",
      action: fence ? "EMAIL_FENCE" : "EMAIL_INVALID",
      ...(fence ? { ruleIds: ["CP-RECIPIENT-FENCE" as const], evaluated: [{ ruleId: "CP-RECIPIENT-FENCE" as const, result: "DENY" as const, detail: `${request.profile}: ${reason}` }] } : {}),
      actor: request.actor ?? defaultActor(request.profile),
      refs: { ...(request.operationId === undefined ? {} : { operationId: request.operationId }), ...(request.messageId === undefined ? {} : { messageId: request.messageId }) },
      reason,
      clockId: request.clockId,
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
      atReal: deps.now().toISOString(),
    });
    deps.log.warn("email refused before SES", { profile: request.profile, code, reason, operationId: request.operationId });
    return { status: "REFUSED", code, reason };
  }

  function commandOf(request: ParsedRequest, fence: Extract<FenceDecision, { allowed: true }>, mailId: string, headers: Array<{ Name: string; Value: string }>): SendEmailCommandInput {
    const from = request.from.displayName === undefined ? fence.from.address : formatMailbox(request.from.displayName, fence.from);
    const attachments = request.profile === "SYSTEM" ? [] : request.attachments;
    return {
      FromEmailAddress: from,
      Destination: { ToAddresses: [fence.to.address] },
      ...(request.replyTo === undefined ? {} : { ReplyToAddresses: [fence.from.address] }),
      Content: {
        Simple: {
          ...simpleContent({ subject: request.subject, text: request.text, lang: request.lang }),
          Headers: headers,
          ...(attachments.length === 0 ? {} : { Attachments: attachments.map((file) => ({ FileName: file.filename, RawContent: file.bytes, ContentType: PDF_CONTENT_TYPE, ContentDisposition: "ATTACHMENT" as const })) }),
        },
      },
      ConfigurationSetName: deps.configurationSet(request.profile),
      EmailTags: tagsOf(request, deps.stage, mailId),
    };
  }

  /** The lead notice: fence, headers and SES only; nothing of a world is read or written. */
  async function sendLeadNotice(request: ParsedLeadNotice): Promise<EmailSendResult> {
    const refused = (code: "INVALID" | "RECIPIENT_NOT_ALLOWED", reason: string): EmailSendResult => {
      deps.log.warn("email refused before SES", { profile: request.profile, code, reason });
      return { status: "REFUSED", code, reason };
    };
    try {
      assertHeaderValue("Subject", request.subject);
      if (request.from.displayName !== undefined) assertHeaderValue("From", request.from.displayName);
    } catch (error) {
      if (error instanceof ChannelError) return refused("INVALID", "HEADER_INVALID");
      throw error;
    }
    const fence = await checkFence(deps.fence, { profile: "LEAD_NOTICE", from: request.from.address, to: request.to });
    if (!fence.allowed) return refused(fence.code, fence.reason);
    let providerMessageId: string | undefined;
    try {
      providerMessageId = (
        await ses().send(
          new SendEmailCommand({
            FromEmailAddress: request.from.displayName === undefined ? fence.from.address : formatMailbox(request.from.displayName, fence.from),
            Destination: { ToAddresses: [fence.to.address] },
            Content: { Simple: simpleContent({ subject: request.subject, text: request.text, lang: request.lang }) },
            ConfigurationSetName: deps.configurationSet(request.profile),
            EmailTags: [
              { Name: "stage", Value: TagValue.parse(deps.stage) },
              { Name: "kind", Value: request.kind },
            ],
          }),
        )
      ).MessageId;
    } catch (error) {
      throw error instanceof ChannelError ? error : sesError(error);
    }
    if (providerMessageId === undefined) throw new ChannelError("SEND_FAILED", "EMAIL", "SES returned no message id", { retryable: false });
    return { status: "SENT", providerMessageId, rfcMessageId: sesRfcMessageId(providerMessageId), awaiting: fence.awaiting, from: fence.from.address, to: fence.to.address };
  }

  async function send(input: EmailSendRequest): Promise<EmailSendResult> {
    const parsed = EmailSendRequest.safeParse(input);
    if (!parsed.success) throw new ChannelError("INVALID", "EMAIL", "invalid email request", { cause: parsed.error });
    if (parsed.data.profile === "LEAD_NOTICE") return sendLeadNotice(parsed.data);
    const request = parsed.data;
    const mailId = request.mailId ?? deps.newMailId();
    let headers: Array<{ Name: string; Value: string }>;
    try {
      headers = headersOf(request, mailId);
      assertHeaderValue("Subject", request.subject);
      if (request.from.displayName !== undefined) assertHeaderValue("From", request.from.displayName);
    } catch (error) {
      if (error instanceof ChannelError) return refuse(request, "INVALID", "HEADER_INVALID");
      throw error;
    }
    if (request.replyTo !== undefined && request.replyTo !== request.from.address) return refuse(request, "INVALID", "REPLY_TO_NOT_FROM");
    if (request.profile !== "SYSTEM" && request.attachments.some((file) => !startsWithPdfMagic(file.bytes))) return refuse(request, "INVALID", "ATTACHMENT_NOT_PDF");

    const fence = await checkFence(deps.fence, intentOf(request));
    if (!fence.allowed) return refuse(request, fence.code, fence.reason, true);

    await deps.world.putMailPending({
      clockId: request.clockId,
      mailId,
      from: fence.from.address,
      to: fence.to.address,
      profile: request.profile,
      awaiting: fence.awaiting,
      sentAtReal: deps.now().toISOString(),
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
    });

    let providerMessageId: string | undefined;
    try {
      providerMessageId = (await ses().send(new SendEmailCommand(commandOf(request, fence, mailId, headers)))).MessageId;
      if (providerMessageId === undefined) throw new ChannelError("SEND_FAILED", "EMAIL", "SES returned no message id", { retryable: false });
    } catch (error) {
      const failure = error instanceof ChannelError ? error : sesError(error);
      try {
        await closeMailPending(deps, { clockId: request.clockId, mailId, from: fence.from.address, outcome: "DISCARDED", reason: INBOUND_REASONS.sendFailed, ...(request.operationId === undefined ? {} : { operationId: request.operationId }) });
      } catch (closeError) {
        // The pending item goes STALE in 10 minutes anyway; the send failure is what the caller must see.
        deps.log.error("could not close the pending mail of a failed send", { mailId, error: closeError });
      }
      throw failure;
    }
    if (request.profile === "SYSTEM") countMetric(deps.log, EMAIL_METRICS.outboundSent, { channel: "EMAIL", kind: request.kind });
    return { status: "SENT", providerMessageId, rfcMessageId: sesRfcMessageId(providerMessageId), mailId, awaiting: fence.awaiting, from: fence.from.address, to: fence.to.address };
  }

  return {
    channel: "EMAIL",
    mode: "live",
    send,
    checkRecipient: (intent) => checkFence(deps.fence, intent),
  };
}
