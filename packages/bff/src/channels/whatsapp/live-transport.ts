// The live transport (docs/architecture-integrations.md §4.1): `SendWhatsAppMessage` with the WABA's
// `originationPhoneNumberId`, the fixed `metaApiVersion` and the Meta JSON as bytes, and
// `GetWhatsAppMessageMedia` into `Media/wa/<wamid>/<mediaId>`. Inside the transport, before AWS is
// called: the recipient fence of live WhatsApp (only the demo phones registered in `SeedOverrides`,
// docs/architecture.md §13) and the refusal of a template Meta has not `APPROVED`. The only client of
// End User Messaging Social: timeouts, retries with backoff and the mapping of its errors live here.
import { GetWhatsAppMessageMediaCommand, SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { ChannelError, ToolError, mediaKeys, normalizePhone, parseSimMediaRef, worldKey } from "@legajo/shared";
import type { ReferencePort } from "../../connector/ports-runtime";
import { awsClientConfig } from "../../lib/clients";
import type { Clock } from "../../lib/clock";
import { sha256Hex } from "../../lib/crypto";
import { type RetryOptions, withRetry } from "../../lib/retry";
import { STAGE_REGION } from "../../public-web/presign";
import { MEDIA_TIMEOUTS, META_API_VERSION, SEND_RETRY, SEND_TIMEOUTS } from "./config";
import { MetaMessage, eumMessageBytes } from "./meta-message";
import type { FetchedMedia, MediaFetch, MediaStore, WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from "./transport";

export interface LiveTransportDeps {
  /** `WhatsAppPhoneNumberId` (lib/secrets.ts `whatsAppConnection`): the live transport exists only once it is connected. */
  readonly phoneNumberId: string;
  /** Physical name of the `Media` bucket. */
  readonly mediaBucket: string;
  /** `SeedOverrides.demoRecipients.phones`: the only numbers live WhatsApp may write to. */
  readonly allowedPhones: readonly string[];
  readonly templates: Pick<ReferencePort, "getTemplate">;
  readonly media: MediaStore;
  readonly realClock: Clock;
  readonly client?: SocialMessagingClient;
  /** Test seam for the backoff. */
  readonly retry?: Pick<RetryOptions, "sleep" | "random">;
}

const THROTTLED = new Set(["ThrottledRequestException", "LimitExceededException"]);
const SERVER_FAILED = new Set(["InternalServiceException", "DependencyException"]);
const TIMED_OUT = new Set(["TimeoutError", "RequestTimeout", "DeadlineError"]);
const REFUSED = new Set(["ValidationException", "InvalidParametersException", "ResourceNotFoundException", "ConflictException"]);

/**
 * One place maps what End User Messaging Social throws to the channel's typed errors. A throttled or
 * failed call was not carried out and is retried; a timeout is retried only for a call that is safe to
 * repeat (a media download), never for a send, which could reach the importer twice.
 */
export function toChannelError(error: unknown, operation: string, repeatable: boolean): ChannelError {
  if (error instanceof ChannelError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = `${operation}: ${name || "unexpected error"}`;
  if (THROTTLED.has(name)) return new ChannelError("RATE_LIMITED", "WHATSAPP", message, { cause: error });
  if (SERVER_FAILED.has(name)) return new ChannelError("SEND_FAILED", "WHATSAPP", message, { cause: error });
  if (TIMED_OUT.has(name)) return new ChannelError("TIMEOUT", "WHATSAPP", message, { cause: error, retryable: repeatable });
  if (REFUSED.has(name)) return new ChannelError("INVALID", "WHATSAPP", message, { cause: error });
  return new ChannelError("UNAVAILABLE", "WHATSAPP", message, { cause: error });
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._=+-]*$/;

/** The `wamid` as a key segment; one with a character a key segment may not carry (a `/`) is hashed. */
function keySegment(value: string): string {
  return SAFE_SEGMENT.test(value) ? value : `h${sha256Hex(value).slice(0, 40)}`;
}

export function liveWhatsAppTransport(deps: LiveTransportDeps): WhatsAppTransport {
  if (deps.phoneNumberId === "" || deps.phoneNumberId === "not-connected") throw new ToolError("UNAVAILABLE", "live WhatsApp needs a connected phone number (docs/pending.md P-01)");
  const allowed = new Set(deps.allowedPhones.map((phone) => normalizePhone(phone)));
  let client = deps.client;
  const sdk = (): SocialMessagingClient => (client ??= new SocialMessagingClient({ region: STAGE_REGION, ...awsClientConfig(SEND_TIMEOUTS) }));
  const retry = <T>(operation: string, repeatable: boolean, run: () => Promise<T>): Promise<T> =>
    withRetry(
      async () => {
        try {
          return await run();
        } catch (error) {
          throw toChannelError(error, operation, repeatable);
        }
      },
      { ...SEND_RETRY, ...deps.retry },
    );

  return {
    channel: "WHATSAPP",
    mode: "live",

    async send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
      const parsed = MetaMessage.safeParse(request.message);
      if (!parsed.success) throw new ChannelError("INVALID", "WHATSAPP", "the message is not a valid Meta message");
      const message = parsed.data;
      if (!allowed.has(normalizePhone(message.to))) throw new ToolError("RECIPIENT_NOT_ALLOWED", "live WhatsApp only writes to the registered demo phones");
      if (message.type === "template") {
        const template = await deps.templates.getTemplate(message.template.name);
        if (template?.status !== "APPROVED") throw new ChannelError("INVALID", "WHATSAPP", `template ${message.template.name} is not APPROVED by Meta`);
      }
      const bytes = eumMessageBytes(message);
      const output = await retry("SendWhatsAppMessage", false, () => sdk().send(new SendWhatsAppMessageCommand({ originationPhoneNumberId: deps.phoneNumberId, message: bytes, metaApiVersion: META_API_VERSION })));
      if (output.messageId === undefined || output.messageId === "") throw new ChannelError("SEND_FAILED", "WHATSAPP", "SendWhatsAppMessage returned no message id");
      return { providerMessageId: output.messageId, simulated: false, status: "SENT", sentAtReal: (await deps.realClock.now()).toISOString() };
    },

    async fetchMedia(input: MediaFetch): Promise<FetchedMedia> {
      if (parseSimMediaRef(input.mediaId) !== undefined) throw new ChannelError("INVALID", "WHATSAPP", "a simulated media reference in live mode");
      if (!SAFE_SEGMENT.test(input.mediaId)) throw new ChannelError("INVALID", "WHATSAPP", "unexpected characters in a media id");
      // The service writes the object at the prefix followed by the media id: `wa/<wamid>/<mediaId>`.
      const stored = worldKey(mediaKeys.whatsapp(keySegment(input.wamid), input.mediaId), input.qaRunId);
      const prefix = stored.slice(0, stored.length - input.mediaId.length);
      const output = await retry("GetWhatsAppMessageMedia", true, () =>
        sdk().send(new GetWhatsAppMessageMediaCommand({ mediaId: input.mediaId, originationPhoneNumberId: deps.phoneNumberId, destinationS3File: { bucketName: deps.mediaBucket, key: prefix } }), {
          requestTimeout: MEDIA_TIMEOUTS.requestTimeoutMs,
        }),
      );
      const head = output.fileSize === undefined || output.mimeType === undefined ? await deps.media.head(stored) : { sizeBytes: output.fileSize, contentType: output.mimeType };
      if (head === undefined) throw new ChannelError("UNAVAILABLE", "WHATSAPP", "the downloaded media is not in the bucket");
      return { key: stored, contentType: head.contentType, sizeBytes: head.sizeBytes };
    },
  };
}
