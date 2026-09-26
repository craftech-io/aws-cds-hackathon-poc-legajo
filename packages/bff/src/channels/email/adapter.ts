// The email channel as a Lambda uses it: the single SES client and the `InboundEmail` and
// `ChannelEvents` cores wired to the stage's own ports (the DynamoDB connector, the links of
// infra/messaging-email.ts, the HKDF subkeys of `SessionTokenKey`, the demo recipients of
// `SeedOverrides` and the stage name). The pipeline, the escalations, `SimMail` and the `QaDriver` get
// the client from here, so none of them builds a fence of its own; it is also the `live` email
// factory of channels/registry.ts.
import { z } from "zod";
import { connector, type Connector } from "../../connector/index";
import { emailHash, ulid } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import { currentStage, readLinked } from "../../lib/resource";
import { seedOverrides, subkey } from "../../lib/secrets";
import type { ChannelEventSink } from "../adapter";
import { EMAIL_SENDER_LINKS } from "./config";
import type { ChannelEventsDeps } from "./events";
import type { FenceDeps } from "./fence";
import type { InboundEmailDeps } from "./inbound";
import { type EmailClient, createEmailClient } from "./outbound";
import { type MailStore, s3MailStore } from "./store";
import { resolveThread } from "./thread";

const realNow = (): Date => new Date();

const SenderLink = z.object({ profile: z.string(), configurationSet: z.string().min(1) });

/** The fence's view of the registry: thread addresses, contacts, keyed email hashes, demo recipients. */
export function stageFenceDeps(data: Pick<Connector, "operations" | "parties" | "world"> = connector()): FenceDeps {
  return {
    resolveThread: (address) => resolveThread({ operations: data.operations, world: data.world, threadKey: subkey("thread"), now: realNow }, address),
    parties: data.parties,
    emailHash: (address) => emailHash(subkey("email-hash"), address),
    demoRecipients: () => seedOverrides().demoRecipients.emails,
  };
}

/** The single SES client of a Lambda. */
export function stageEmailClient(log: Logger, data: Connector = connector()): EmailClient {
  return createEmailClient({
    fence: stageFenceDeps(data),
    world: data.world,
    runtime: data.runtime,
    audit: data.audit,
    configurationSet: (profile) => readLinked(EMAIL_SENDER_LINKS[profile], SenderLink).configurationSet,
    stage: currentStage(),
    now: realNow,
    newMailId: () => ulid(realNow().getTime()),
    log,
  });
}

/** Ports of `InboundEmail`; the queue producer comes from the entry that owns the queue. */
export function stageInboundEmailDeps(input: { readonly log: Logger; readonly events: ChannelEventSink; readonly store?: MailStore; readonly data?: Connector }): InboundEmailDeps {
  return {
    data: input.data ?? connector(),
    store: input.store ?? s3MailStore(),
    events: input.events,
    threadKey: subkey("thread"),
    now: realNow,
    log: input.log,
  };
}

/** Ports of `ChannelEvents`. */
export function stageChannelEventsDeps(input: { readonly log: Logger; readonly events: ChannelEventSink; readonly data?: Connector }): ChannelEventsDeps {
  const data = input.data ?? connector();
  return {
    conversations: data.conversations,
    world: data.world,
    pending: { world: data.world, runtime: data.runtime, now: realNow },
    events: input.events,
    log: input.log,
  };
}
