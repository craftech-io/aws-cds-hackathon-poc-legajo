// The one interface both WhatsApp transports implement (ADR-0002): the live one over End User Messaging
// Social and the simulated one of the phone simulator. `channels/registry.ts` instantiates one of them
// from `ChannelModes.whatsapp` (registry.ts here builds it); nothing outside the transport knows the
// mode. A transport sends a validated Meta message and puts the media of an inbound message in the
// `Media` bucket; the outbound pipeline persists the `Message OUT` with what `send` returns.
import type { ChannelTransport } from "../adapter";
import type { MetaMessage } from "./meta-message";

/** The `Message OUT` row a send belongs to: the simulated transport records its synthetic statuses on it. */
export interface SendRecord {
  readonly operationId: string;
  readonly clockId: string;
  readonly messageId: string;
}

export interface WhatsAppSendRequest {
  readonly message: MetaMessage;
  /** Absent only for the fixed reply to an unregistered number, which has no operation. */
  readonly record?: SendRecord;
}

export interface WhatsAppSendResult {
  /** The `wamid` of the message; `statuses[]` refer to it (GSI1 `providerMessageId`). */
  readonly providerMessageId: string;
  readonly simulated: boolean;
  /** Status the `Message OUT` starts with: live `SENT` (delivery arrives by SNS); simulated `DELIVERED` (its events are recorded). */
  readonly status: "SENT" | "DELIVERED";
  readonly sentAtReal: string;
}

/** An inbound media object, already in the `Media` bucket. */
export interface FetchedMedia {
  readonly key: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface MediaFetch {
  /** `document.id` (and the like) of the inbound message: a Meta media id, or `sim-media:<key>`. */
  readonly mediaId: string;
  readonly wamid: string;
  /** World of the importer: a simulated key has to belong to it (`qa/<runId>/` exactly in a QA world). */
  readonly clockId: string;
  /** Run of a QA world (the clock's `runId`): live keys of that world carry the `qa/<runId>/` prefix. */
  readonly qaRunId?: string;
}

export interface WhatsAppTransport extends ChannelTransport<WhatsAppSendRequest, WhatsAppSendResult> {
  readonly channel: "WHATSAPP";
  /** Live: `GetWhatsAppMessageMedia` into `Media/wa/<wamid>/<mediaId>`. Simulated: the `sim-media:` key the phone uploaded. */
  fetchMedia(input: MediaFetch): Promise<FetchedMedia>;
  /**
   * Live only: marks the importer's message read (blue ticks) and shows WhatsApp's "typing…" animation
   * until the reply arrives or about 25 s pass. Best effort: a failure never stops the turn.
   */
  markReadTyping?(wamid: string): Promise<void>;
}

/** What the bytes of a media object say: its SHA-256 (hex) and whether they start with `%PDF-`. */
export interface MediaDigest {
  readonly sha256: string;
  readonly isPdf: boolean;
  readonly sizeBytes: number;
}

/** What the transports and the inbound adapter need of the `Media` bucket. */
export interface MediaStore {
  /** Size and type of an object, `undefined` when it does not exist. */
  head(key: string): Promise<{ readonly sizeBytes: number; readonly contentType: string } | undefined>;
  /** Reads an object already checked against the size limit, for the intake's SHA-256 and the `%PDF-` check. */
  digest(key: string): Promise<MediaDigest>;
  delete(key: string): Promise<void>;
}
