// The WhatsApp channel as a Lambda uses it: the transport of the stage's mode (`ChannelModes.whatsapp`,
// linked, never from the environment), `InboundWhatsApp`'s ports and the phone simulator's way in,
// wired to the stage's own resources (the DynamoDB connector, the `Media` bucket, the HKDF subkeys of
// `SessionTokenKey`, the WABA connection and the demo phones of `SeedOverrides`). The outbound
// pipeline and channels/registry.ts get the transport from here; `handlers/inbound-whatsapp.ts` gets
// its deps; the console's simulator router and the `QaDriver` get the simulator. Nothing else builds a
// WhatsApp client.
import { z } from "zod";
import { ToolError } from "@legajo/shared";
import { connector, type Connector } from "../../connector/index";
import { systemClock } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import { bucketName, channelMode, readLinked } from "../../lib/resource";
import { seedOverrides, subkey, whatsAppConnection } from "../../lib/secrets";
import type { ChannelEventSink } from "../adapter";
import { STAGE_ACCOUNT_ID, waInboundTopicArn } from "./config";
import { s3MediaStore } from "./media-store";
import type { ChannelServices, SystemReplies, WhatsAppInboundDeps } from "./ports";
import { type TransportFactoryDeps, createWhatsAppTransport, whatsAppFactories } from "./registry";
import { type PhoneSimulatorDeps, lambdaEnvelopeDelivery } from "./simulator";
import type { MediaStore, WhatsAppTransport } from "./transport";

/** The linked `InboundWhatsApp` function (Bff and QaDriver link it to invoke it with the simulator's envelope). */
const LinkedFunction = z.object({ name: z.string().min(1) });

export function stageMediaStore(): MediaStore {
  return s3MediaStore({ bucket: bucketName("Media") });
}

function stageTransportDeps(log: Logger, data: Connector, media: MediaStore): TransportFactoryDeps {
  return {
    simulated: { conversations: data.conversations, templates: data.reference, media, realClock: systemClock, log },
    live: () => {
      const connection = whatsAppConnection();
      if (connection === undefined) throw new ToolError("UNAVAILABLE", "live WhatsApp needs WabaId and WhatsAppPhoneNumberId (docs/pending.md P-01)");
      return { phoneNumberId: connection.phoneNumberId, mediaBucket: bucketName("Media"), allowedPhones: seedOverrides().demoRecipients.phones, templates: data.reference, media, realClock: systemClock };
    },
  };
}

/** One factory per mode, for channels/registry.ts: the registry picks the one `ChannelModes` names. */
export function stageWhatsAppFactories(log: Logger, data: Connector = connector(), media: MediaStore = stageMediaStore()): ReturnType<typeof whatsAppFactories> {
  return whatsAppFactories(stageTransportDeps(log, data, media));
}

/** The transport of the stage's mode. */
export function stageWhatsAppTransport(log: Logger, data: Connector = connector(), media: MediaStore = stageMediaStore()): WhatsAppTransport {
  return createWhatsAppTransport(channelMode("whatsapp"), stageTransportDeps(log, data, media));
}

/** Ports of `InboundWhatsApp`; the queue producer, the pipeline and the channel services come from their owners. */
export function stageInboundWhatsAppDeps(input: {
  readonly log: Logger;
  readonly events: ChannelEventSink;
  readonly replies: SystemReplies;
  readonly services: ChannelServices;
  readonly data?: Connector;
}): WhatsAppInboundDeps {
  const data = input.data ?? connector();
  const media = stageMediaStore();
  return {
    mode: channelMode("whatsapp"),
    data,
    keys: { phoneHash: subkey("phone-hash"), simEnvelope: subkey("sim-envelope"), nonce: subkey("nonce") },
    source: { topicArn: waInboundTopicArn(), accountId: STAGE_ACCOUNT_ID },
    transport: stageWhatsAppTransport(input.log, data, media),
    media,
    events: input.events,
    replies: input.replies,
    services: input.services,
    realClock: systemClock,
    log: input.log,
  };
}

/** The phone simulator of the console and of the `QaDriver`: signs with `sim-envelope` and invokes `InboundWhatsApp`. */
export function stagePhoneSimulator(): PhoneSimulatorDeps {
  return {
    simEnvelopeKey: subkey("sim-envelope"),
    delivery: lambdaEnvelopeDelivery({ functionName: () => readLinked("InboundWhatsApp", LinkedFunction).name }),
    realClock: systemClock,
  };
}
