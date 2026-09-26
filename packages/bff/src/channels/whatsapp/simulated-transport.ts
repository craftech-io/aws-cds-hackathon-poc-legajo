// `SimulatedWhatsAppTransport` (docs/architecture-integrations.md §4.2): validates the same Meta JSON
// with the same schema as the live transport and records the synthetic statuses Meta would send, with
// the same `statuses[]` shape: `sent` at once, `delivered` one second later, `read` when the phone
// simulator marks the thread read. A template renders from `Reference/TEMPLATE#WHATSAPP` even while it
// is `LOCAL_ONLY` (it only has to exist). Media comes from the `sim-media:<key>` the phone uploaded to
// `Media/sim/…`, never from `GetWhatsAppMessageMedia`.
import { ChannelError, parseClockId, parseSimMediaKey, parseSimMediaRef } from "@legajo/shared";
import type { ConversationsPort, ReferencePort } from "../../connector/ports-runtime";
import { importerCounterpartKey } from "../../connector/keys";
import type { Clock } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import { SIM_DELIVERED_AFTER_MS } from "./config";
import { applyStatuses, messageEventOf } from "./events";
import { MetaMessage } from "./meta-message";
import type { WaStatus, WaStatusValue } from "./payloads";
import { newSimulatedWamid } from "./sim-envelope";
import type { FetchedMedia, MediaFetch, MediaStore, SendRecord, WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from "./transport";

export interface SimulatedTransportDeps {
  readonly conversations: ConversationsPort;
  readonly templates: Pick<ReferencePort, "getTemplate">;
  readonly media: MediaStore;
  /** Real time: the synthetic statuses carry real timestamps, as Meta's do. */
  readonly realClock: Clock;
  readonly log: Logger;
  /** Test seam for the `wamid.SIM.<id>` of each send. */
  readonly newWamid?: (nowMs: number) => string;
}

export interface SimulatedWhatsAppTransport extends WhatsAppTransport {
  readonly mode: "simulated";
  /** "Marcar leído": `read` for every delivered message of the importer's thread; answers how many changed. */
  markRead(importerId: string): Promise<number>;
}

function syntheticStatus(wamid: string, to: string, status: WaStatusValue, atMs: number): WaStatus {
  return { id: wamid, status, timestamp: String(Math.floor(atMs / 1_000)), recipient_id: to };
}

/** A QA world reads only its own `qa/<runId>/` keys, and no other world reads them. */
export function keyOfWorld(key: string, clockId: string): boolean {
  const runId = parseSimMediaKey(key)?.qaRunId;
  if (runId === undefined) return parseClockId(clockId)?.scope !== "QA";
  return clockId.startsWith(`qa-${runId}-`);
}

function invalid(message: string): ChannelError {
  return new ChannelError("INVALID", "WHATSAPP", message);
}

export function simulatedWhatsAppTransport(deps: SimulatedTransportDeps): SimulatedWhatsAppTransport {
  const newWamid = deps.newWamid ?? newSimulatedWamid;

  async function recordStatuses(record: SendRecord, wamid: string, to: string, sentAtMs: number): Promise<void> {
    for (const [status, atMs] of [["sent", sentAtMs], ["delivered", sentAtMs + SIM_DELIVERED_AFTER_MS]] as const) {
      await deps.conversations.recordMessageEvent(messageEventOf(syntheticStatus(wamid, to, status, atMs), record, true));
    }
  }

  return {
    channel: "WHATSAPP",
    mode: "simulated",

    async send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
      const parsed = MetaMessage.safeParse(request.message);
      if (!parsed.success) throw invalid("the message is not a valid Meta message");
      const message = parsed.data;
      if (message.type === "template" && (await deps.templates.getTemplate(message.template.name)) === undefined) {
        throw invalid(`template ${message.template.name} is not registered in Reference`);
      }
      const sentAt = await deps.realClock.now();
      const wamid = newWamid(sentAt.getTime());
      if (request.record !== undefined) await recordStatuses(request.record, wamid, message.to, sentAt.getTime());
      return { providerMessageId: wamid, simulated: true, status: request.record === undefined ? "SENT" : "DELIVERED", sentAtReal: sentAt.toISOString() };
    },

    async fetchMedia(input: MediaFetch): Promise<FetchedMedia> {
      const key = parseSimMediaRef(input.mediaId);
      if (key === undefined) throw invalid("simulated media must be a sim-media: reference");
      if (!keyOfWorld(key, input.clockId)) throw invalid("the media key belongs to another world");
      const head = await deps.media.head(key);
      if (head === undefined) throw invalid("the simulated media object does not exist");
      return { key, contentType: head.contentType, sizeBytes: head.sizeBytes };
    },

    async markRead(importerId: string): Promise<number> {
      const outbound = await deps.conversations.listCounterpartMessages(importerCounterpartKey(importerId), { direction: "OUT" });
      const at = (await deps.realClock.now()).getTime();
      const statuses = outbound
        .filter((message) => message.channel === "WHATSAPP" && message.simulated && message.providerMessageId !== undefined && (message.status === "SENT" || message.status === "DELIVERED"))
        .map((message) => syntheticStatus(message.providerMessageId ?? "", message.to.replace(/^\+/, ""), "read", at));
      const outcomes = await applyStatuses(statuses, deps, true);
      return outcomes.filter((outcome) => outcome.outcome === "APPLIED").length;
    },
  };
}
