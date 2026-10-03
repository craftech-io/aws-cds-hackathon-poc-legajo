// The entry points of a local world (docs/test-plan.md §3, "Flujos locales"): the same Lambda handlers
// the stage runs, built with their `create…Handler(depsFor)` factories over the local stage, and the
// worker over the in-process FIFO. Mail between the parties goes through the mailroom: what the SES
// client sent lands in SimMail (`sim-poc`) or in InboundEmail (`ops-poc`), as the receipt rules route it.
import { channelServices } from "@legajo/bff/services/contacts/channel-services";
import { createChannelEventsHandler } from "@legajo/bff/handlers/channel-events";
import { createDocumentIntakeHandler } from "@legajo/bff/handlers/document-intake";
import { s3MediaStore } from "@legajo/bff/channels/whatsapp/media-store";
import { createFeedEventsHandler } from "@legajo/bff/handlers/feed-events";
import { createInboundEmailHandler } from "@legajo/bff/handlers/inbound-email";
import { createInboundWhatsAppHandler, pipelineSystemReplies } from "@legajo/bff/handlers/inbound-whatsapp";
import { createScheduleDispatchHandler } from "@legajo/bff/handlers/schedule-dispatch";
import { STAGE_ACCOUNT_ID, waInboundTopicArn } from "@legajo/bff/channels/whatsapp/config";
import type { WhatsAppInboundDeps } from "@legajo/bff/channels/whatsapp/ports";
import { s3MailStore } from "@legajo/bff/channels/email/store";
import { advanceClock } from "@legajo/bff/clock/advance";
import type { SimReplyHandoff } from "@legajo/bff/timers/events";
import { simReplyInvocation } from "@legajo/bff/sim-mail/contract";
import { type SimMailDeps, receiveSimMail } from "@legajo/bff/sim-mail/receive";
import { fireSimReply } from "@legajo/bff/sim-mail/supplier-simulator";
import type { SeedPdfStore } from "@legajo/bff/sim-mail/seed-pdfs";
import { resolveThread } from "@legajo/bff/channels/email/thread";
import { emailHash, ulid } from "@legajo/bff/lib/crypto";
import type { FlowEntries } from "../ports";
import { LOCAL_BUCKETS, MAIL_ROUTES, type StageContext } from "./context";
import { deliveriesOf } from "./mailroom";
import type { StageWorker } from "./worker";

export interface LocalEntries extends FlowEntries {
  /** `ChannelEvents` with an SES event of EventBridge (bounces, complaints, deliveries). */
  channelEvent(event: unknown): Promise<unknown>;
  /** SimMail with a receipt of the `sim-poc` rule. */
  simMail(event: unknown): Promise<unknown>;
  /** GuardDuty's scan of every new object of `Media` and `Uploads` (`THREATS_FOUND` for the keys in `threats`). */
  scanObjects(): Promise<number>;
  /** Object keys GuardDuty will report as infected. */
  readonly threats: Set<string>;
  /** Delivers what SES sent since the last call; answers how many receipts it handed on. */
  deliverMail(): Promise<number>;
  /** Drains the queue and delivers mail until nothing moves: the world is quiet. */
  settle(): Promise<void>;
}

/** SimMail's dependencies (sim-mail/stage.ts) over the local stage and the `Seed` bucket in a map. */
export function simMailDeps(stage: StageContext, seed: SeedPdfStore): SimMailDeps {
  const { data, now, log } = stage;
  return {
    data,
    store: s3MailStore({ inbound: () => ({ name: LOCAL_BUCKETS.mail, prefix: MAIL_ROUTES.sim }) }),
    email: stage.outbound.email,
    seed,
    resolveThread: (address) => resolveThread({ operations: data.operations, world: data.world, threadKey: stage.key("thread"), now }, address),
    emailHash: (address) => emailHash(stage.key("email-hash"), address),
    now,
    scheduler: stage.scheduler,
    log,
  };
}

/** `ScheduleDispatch` hands a due `SIM_REPLY` to SimMail asynchronously; here it runs in process. */
export function simReplyHandoff(deps: () => SimMailDeps): (handoff: SimReplyHandoff) => Promise<void> {
  return async (handoff) => {
    await fireSimReply(deps(), simReplyInvocation(handoff));
  };
}

export function createLocalEntries(stage: StageContext, worker: StageWorker, seed: SeedPdfStore): LocalEntries {
  const { data, now, log } = stage;
  const sim = simMailDeps(stage, seed);
  const inboundWhatsApp = createInboundWhatsAppHandler(
    (entryLog): WhatsAppInboundDeps => ({
      mode: "simulated",
      data,
      keys: { phoneHash: stage.key("phone-hash"), simEnvelope: stage.key("sim-envelope"), nonce: stage.key("nonce") },
      source: { topicArn: waInboundTopicArn(), accountId: STAGE_ACCOUNT_ID },
      transport: stage.transport,
      media: stage.media,
      events: stage.sink,
      replies: pipelineSystemReplies(stage.outbound, entryLog),
      services: channelServices(stage.services),
      realClock: { now: async () => now() },
      log: entryLog,
    }),
    () => log,
  );
  const inboundEmail = createInboundEmailHandler(
    (entryLog) => ({ data, store: s3MailStore({ inbound: () => ({ name: LOCAL_BUCKETS.mail, prefix: MAIL_ROUTES.ops }), quarantine: () => ({ name: LOCAL_BUCKETS.quarantine, prefix: "" }) }), events: stage.sink, threadKey: stage.key("thread"), now, log: entryLog }),
    () => log,
  );
  const feedEvent = createFeedEventsHandler((entryLog) => ({ data, events: stage.sink, wallClock: now, log: entryLog }), () => log);
  const timerFire = createScheduleDispatchHandler((entryLog) => ({ data, scheduler: stage.scheduler, dispatcher: stage.dispatcher(), realClock: now, log: entryLog }), () => log);
  const channelEvent = createChannelEventsHandler(
    (entryLog) => ({
      channel: { conversations: data.conversations, world: data.world, pending: { world: data.world, runtime: data.runtime, now }, events: stage.sink, log: entryLog },
      mailStatus: { client: stage.stores.client, leadEmailKey: stage.key("lead-email"), log: entryLog, now },
    }),
    () => log,
  );
  const documentIntake = createDocumentIntakeHandler(
    (entryLog) => ({ data, events: stage.sink, buckets: { uploads: () => LOCAL_BUCKETS.uploads, media: () => LOCAL_BUCKETS.media }, uploads: s3MediaStore({ bucket: LOCAL_BUCKETS.uploads }), wallClock: now, log: entryLog }),
    () => log,
  );
  const threats = new Set<string>();
  const scanned = new Set<string>();

  async function scanObjects(): Promise<number> {
    let count = 0;
    for (const bucket of [LOCAL_BUCKETS.media, LOCAL_BUCKETS.uploads]) {
      for (const key of stage.aws.objects.keys(bucket)) {
        if (scanned.has(`${bucket}/${key}`)) continue;
        scanned.add(`${bucket}/${key}`);
        const status = threats.has(key) ? "THREATS_FOUND" : "NO_THREATS_FOUND";
        await documentIntake({ source: "aws.guardduty", "detail-type": "GuardDuty Malware Protection Object Scan Result", detail: { scanStatus: "COMPLETED", resourceType: "S3_OBJECT", s3ObjectDetails: { bucketName: bucket, objectKey: key }, scanResultDetails: { scanResultStatus: status } } });
        count += 1;
      }
    }
    return count;
  }

  let delivered = 0;
  let inboundIds = 0;

  async function deliverMail(): Promise<number> {
    let handed = 0;
    while (delivered < stage.aws.sesMessages.length) {
      const sent = stage.aws.sesMessages[delivered];
      delivered += 1;
      if (sent === undefined) continue;
      const deliveries = deliveriesOf(sent, stage.aws.objects, () => `inbound-local-${ulid(now().getTime() + (inboundIds += 1)).toLowerCase()}`, now());
      for (const delivery of deliveries) {
        if (delivery.route === "sim") await receiveSimMail(delivery.event, sim);
        else await inboundEmail(delivery.event);
        handed += 1;
      }
    }
    return handed;
  }

  const drain = () => stage.aws.queue.drain(worker.run);

  return {
    inboundWhatsApp,
    inboundEmail,
    feedEvent,
    timerFire,
    async advanceClock(clockId, move) {
      await advanceClock({ clockId, target: move, caller: { actor: "QA" } }, stage.timerDeps());
    },
    drain,
    channelEvent,
    simMail: (event) => receiveSimMail(event, sim),
    scanObjects,
    threats,
    deliverMail,
    async settle() {
      for (let round = 0; round < 50; round += 1) {
        const scans = await scanObjects();
        const processed = await drain();
        const mail = await deliverMail();
        if (scans === 0 && processed === 0 && mail === 0 && stage.aws.queue.pending().length === 0) return;
      }
      throw new Error("the local world did not settle after 50 rounds of scans, queue and mail");
    },
  };
}
