// What the inbound WhatsApp adapter needs from the rest of the system. `handlers/inbound-whatsapp.ts`
// (a thin Lambda entry) builds these with adapter.ts from the real modules: the FIFO producer of the
// entry that owns the queue, the outbound pipeline for the fixed replies, the consent and contact
// handlers of `services/`. The adapter decides the order and what happens; these ports only do it.
import type { ChannelMode } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import type { MessageButton } from "../../domain/conversations";
import type { Clock } from "../../lib/clock";
import type { SecretKey } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import type { ChannelEventSink } from "../adapter";
import type { EnvelopeExpectations } from "./registry";
import type { MediaStore, WhatsAppTransport } from "./transport";

/** A fixed text of `copy/es-AR.ts` the system (`author SYSTEM`, never the model) sends back to the importer. */
export interface SystemReplyRequest {
  readonly kind: "REPLY" | "OPERATION_CHOICE";
  /** Which fixed text (`ImporterTexts` key): the gloss and the audit name it. */
  readonly textKey: "rateLimited" | "rejectedMedia" | "mediaTooLarge" | "questionPrompt" | "operationChoice";
  readonly body: string;
  readonly operationId: string;
  readonly importerId: string;
  readonly firmId: string;
  readonly clockId: string;
  /** Id of the `Message OUT` (derived from the inbound `wamid`, so a redelivery never sends twice). */
  readonly messageId: string;
  /** The importer's message it answers: it opened the 24 h window and exempts the reply from `CP-HOURS-AR`. */
  readonly inReplyTo: { readonly messageId: string; readonly wamid: string };
  readonly atSim: string;
  /** `OPERATION_CHOICE`: an interactive list, one row per open operation, each with its nonce. */
  readonly list?: {
    readonly buttonTitle: string;
    readonly rows: readonly { readonly nonce: string; readonly title: string; readonly description: string; readonly operationId: string }[];
  };
  /** What the `Message OUT` records as its buttons (the list rows as `CHOOSE_OPERATION`). */
  readonly buttons: readonly MessageButton[];
}

export interface SystemReplies {
  /** The outbound pipeline for a fixed reply: policy, transport, `Message OUT` and `AuditLog`. */
  reply(request: SystemReplyRequest): Promise<{ readonly status: "SENT" | "DEFERRED" | "DENIED" }>;
}

export interface ChannelServices {
  /** `revoke_consent` with principal `channel`: `revokedAt`, `OPT_OUT_CONFIRMATION` and `ESCALATE(OPTED_OUT)` from the `wamid`. */
  revokeConsent(input: {
    readonly importerId: string;
    readonly firmId: string;
    readonly clockId: string;
    readonly operationIds: readonly string[];
    readonly messageId: string;
    readonly wamid: string;
    readonly atSim: string;
    readonly via: "BUTTON" | "KEYWORD";
  }): Promise<void>;
  /** `confirm_supplier_contact` with principal `channel`: the contact `ACTIVE` (or discarded) and `AGENT_TURN(CONTACT_CONFIRMED)` from the `wamid`. */
  confirmContact(input: {
    readonly operationId: string;
    readonly importerId: string;
    readonly firmId: string;
    readonly clockId: string;
    readonly supplierId: string;
    readonly contactId: string;
    readonly decision: "CONFIRM" | "REJECT";
    readonly messageId: string;
    readonly wamid: string;
    readonly atSim: string;
  }): Promise<void>;
}

export interface WhatsAppKeys {
  /** Subkey `phone-hash`: identity by registered phone. */
  readonly phoneHash: SecretKey;
  /** Subkey `sim-envelope`: signature of the phone simulator's envelope. */
  readonly simEnvelope: SecretKey;
  /** Subkey `nonce`: the nonces of the `OPERATION_CHOICE` rows. */
  readonly nonce: SecretKey;
}

export interface WhatsAppInboundDeps {
  readonly mode: ChannelMode;
  readonly data: Connector;
  readonly keys: WhatsAppKeys;
  /** Topic and account a live envelope must come from (the simulated key is `keys.simEnvelope`). */
  readonly source: Omit<EnvelopeExpectations, "mode" | "simEnvelopeKey">;
  /** The transport of the mode: media of inbound messages and the reply to an unregistered number. */
  readonly transport: WhatsAppTransport;
  readonly media: MediaStore;
  /** Producer of `OperationEvents.fifo` (channels/adapter.ts): `inFlight` first, then `SendMessage`. */
  readonly events: ChannelEventSink;
  readonly replies: SystemReplies;
  readonly services: ChannelServices;
  /** Real time (nonce expiry, idempotency stamps); simulated time comes from each world's clock. */
  readonly realClock: Clock;
  readonly log: Logger;
}
