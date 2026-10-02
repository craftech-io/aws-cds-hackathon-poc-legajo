// Feed events as the `Feeds` bus rule delivers them (packages/platform-mock/src/events.ts), over the
// email channel's demo slice (op-4471 and op-4483 of `firm-delta`, clock paused), with a queue that
// records what `FeedEvents` enqueued.
import { emailWorld, type EmailWorld } from "../channels/email/testing";
import { createLogger } from "../lib/log";
import { REAL_NOW } from "../connector/testing";
import type { DispatchStatusEvent, EtaChangedEvent } from "../worker/events";
import type { FeedEventsDeps } from "./feed-events";

export const ETA_EVENT_ID = "evt_01JQ7ZK8X4M2N6P9R3T5V7W9Y1";
export const CUSTOMS_EVENT_ID = "evt_01JQ7ZK8X4M2N6P9R3T5V7W9Y2";

export function etaEnvelope(overrides: { readonly eventId?: string; readonly firmId?: string; readonly operationNumber?: string; readonly newEta?: string } = {}): unknown {
  return {
    version: "0",
    id: "6a7e8feb-b491-4cf7-a9f1-bf3703467718",
    source: "mock.platform.carrier",
    "detail-type": "CarrierEtaChanged",
    account: "776805327629",
    time: "2026-10-16T12:30:00Z",
    region: "us-east-1",
    resources: [],
    detail: {
      eventId: overrides.eventId ?? ETA_EVENT_ID,
      firmId: overrides.firmId ?? "firm-delta",
      operationNumber: overrides.operationNumber ?? "4471",
      vessel: "Austral Aurora",
      previousEta: "2026-10-22T08:00:00-03:00",
      newEta: overrides.newEta ?? "2026-10-20T08:00:00-03:00",
      reason: "SCHEDULE_ADVANCED",
      occurredAtSim: "2026-10-16T09:30:00-03:00",
    },
  };
}

export function customsEnvelope(overrides: { readonly eventId?: string; readonly operationNumber?: string; readonly status?: string; readonly channel?: string } = {}): unknown {
  const status = overrides.status ?? "OFICIALIZADO";
  return {
    version: "0",
    id: "7b8f9a0c-b491-4cf7-a9f1-bf3703467719",
    source: "mock.platform.customs",
    "detail-type": "CustomsStatusChanged",
    time: "2026-10-21T14:00:00Z",
    detail: {
      eventId: overrides.eventId ?? CUSTOMS_EVENT_ID,
      firmId: "firm-delta",
      operationNumber: overrides.operationNumber ?? "4471",
      status,
      ...(overrides.channel === undefined ? {} : { channel: overrides.channel }),
      occurredAtSim: "2026-10-21T11:00:00-03:00",
    },
  };
}

export interface FeedWorld {
  readonly email: EmailWorld;
  readonly deps: FeedEventsDeps;
  readonly enqueued: Array<EtaChangedEvent | DispatchStatusEvent>;
  readonly lines: string[];
}

export async function feedWorld(options: { readonly failEnqueue?: boolean } = {}): Promise<FeedWorld> {
  const email = await emailWorld();
  const enqueued: Array<EtaChangedEvent | DispatchStatusEvent> = [];
  const lines: string[] = [];
  const { connector } = email.stores;
  const deps: FeedEventsDeps = {
    data: connector,
    events: {
      enqueue: async (event) => {
        if (options.failEnqueue === true) throw new Error("SendMessage failed");
        await connector.world.markInFlight({ operationId: event.operationId, clockId: event.clockId, eventId: event.eventId });
        enqueued.push(event);
      },
    },
    wallClock: () => new Date(REAL_NOW),
    log: createLogger({ correlationId: "test-feeds-0001", level: "debug", sink: (line) => lines.push(line), now: () => new Date(REAL_NOW) }),
  };
  return { email, deps, enqueued, lines };
}

/** Moves op-4471 to `APPROVED` the way the console does (`READY_FOR_REVIEW` first). */
export async function approve(world: Pick<FeedWorld, "email">, operationId = "op-4471"): Promise<void> {
  const { operations } = world.email.stores.connector;
  await operations.transitionDossier({ operationId, to: "READY_FOR_REVIEW", atSim: "2026-10-20T10:00:00-03:00", by: "AGENT" });
  await operations.transitionDossier({ operationId, to: "APPROVED", approvedBy: "brk-ana-sosa", atSim: "2026-10-20T11:00:00-03:00", by: "BROKER:brk-ana-sosa" });
}
