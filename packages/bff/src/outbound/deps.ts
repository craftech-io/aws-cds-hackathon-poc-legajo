// What the outbound pipeline needs, as ports: the connector, the single SES client, the WhatsApp
// transport of each world, G2, the fence's view of the registry, the counters of the guest-world
// quotas, the `nonce` subkey, the upload links, the arming of a deferred send's timer, the holidays and
// the real clock. stage.ts builds them for a Lambda from its links (never `process.env`); tests and
// the local flows build them over the in-memory connector and fakes.
import type { ChannelMode, DocType } from "@legajo/shared";
import type { FenceDeps } from "../channels/email/fence";
import type { EmailClient } from "../channels/email/outbound";
import type { WhatsAppTransport } from "../channels/whatsapp/transport";
import type { Connector, TableClient } from "../connector/index";
import type { SecretKey } from "../lib/crypto";
import type { HolidayCalendar } from "../services/holidays";
import type { G2Config, OutputGuardrail } from "./grounding";

/** The WhatsApp side of one world: its transport, the mode it runs in and our number as `Message.from`. */
export interface WhatsAppRoute {
  readonly transport: WhatsAppTransport;
  readonly mode: ChannelMode;
  readonly from: string;
}

export interface UploadLink {
  readonly token: string;
  readonly url: string;
}

/**
 * The upload link a template's URL button carries (docs/architecture-integrations.md §7: the render
 * of a template creates it with `create_upload_link`): the one this turn already created, or a new one.
 */
export interface UploadLinks {
  issue(input: { readonly operationId: string; readonly firmId: string; readonly docTypes: readonly DocType[] }): Promise<UploadLink>;
}

/** The `TIMER#DEFERRED_SEND#<messageId>` of a deferred send (docs/architecture.md §8). */
export interface DeferredTimerSpec {
  readonly operationId: string;
  readonly clockId: string;
  readonly timerId: string;
  /** `nextAllowedAt` of the policy. */
  readonly dueAtSim: string;
  /** The rule that deferred it (`CP-HOURS-SUPPLIER`, …), what the console shows as the pending's motive. */
  readonly reason: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Creates the timer and gives it its real schedule (timers/ `armTimer`): a paused world needs none
 * (moving its clock dispatches what fell due from GSI3), a running one gets a schedule within its
 * one-hour horizon. A key that already exists is a `CONFLICT` (`ConnectorError`).
 */
export interface TimerArming {
  arm(spec: DeferredTimerSpec): Promise<{ readonly timerKey: string }>;
}

export interface OutboundDeps {
  readonly data: Connector;
  /** The single SES client (channels/email/outbound.ts): the fence runs again inside `send`. */
  readonly email: Pick<EmailClient, "send">;
  /**
   * The transport of a send to `phoneE164` in a world: live only in a `live` stage, outside guest worlds
   * (ADR-0015 §4) and to a demo phone of `SeedOverrides`; every other importer keeps the phone simulator.
   */
  readonly whatsapp: (clockId: string, phoneE164?: string) => WhatsAppRoute;
  readonly guardrail: OutputGuardrail;
  readonly g2Limits: () => Pick<G2Config, "queryMaxChars" | "groundingSourceMaxChars">;
  readonly fence: FenceDeps;
  /** `Runtime` table client of `worlds/guest-quotas.ts` (`QUOTA#…` counters). */
  readonly quotaTable: TableClient;
  /** Subkey `nonce` of the buttons. */
  readonly nonceKey: () => SecretKey;
  /** `email-hash` subkey of a contact's `emailHash` (`ADDR#` claim). */
  readonly emailHash: (address: string) => string;
  readonly uploadLinks: UploadLinks;
  readonly arming: TimerArming;
  /** National holidays of Argentina (`Reference/REF#HOLIDAY#AR`). */
  readonly holidays: () => Promise<HolidayCalendar>;
  /** Real time: `sentAtReal`, the window in live mode, the quotas. */
  readonly wallClock: () => Date;
  /** A new id (ULID) for messages and timers. */
  readonly newId: () => string;
}
