// `SimMail` as a Lambda wires it (infra/messaging-email.ts): the DynamoDB connector, the single SES
// client (only the `SIMULATOR` profile is linked: `Resource.EmailSenderSimulator`), the raw MIME of the
// `sim` route of the mail bucket (`Resource.InboundMailSim`, read only), the seed's PDFs
// (`Resource.Seed`), the stage's Scheduler client for the timers of a RUNNING world
// (`Resource.Scheduler`, capability TIMERS), the HKDF subkeys `thread` and `email-hash` of
// `SessionTokenKey`, and real time. Nothing here reads `process.env`.
import { stageEmailClient } from "../channels/email/adapter";
import { PrefixedBucket, s3MailStore } from "../channels/email/store";
import { resolveThread } from "../channels/email/thread";
import { connector } from "../connector/index";
import { emailHash } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { subkey } from "../lib/secrets";
import { type SchedulerPort, eventBridgeScheduler } from "../timers/scheduler-client";
import { INBOUND_MAIL_SIM_LINK } from "./config";
import type { SimMailDeps } from "./receive";
import { s3SeedPdfStore } from "./seed-pdfs";

let seed: ReturnType<typeof s3SeedPdfStore> | undefined;
let scheduler: SchedulerPort | undefined;

export interface StageSimMailOptions {
  readonly log: Logger;
}

export function stageSimMailDeps(options: StageSimMailOptions): SimMailDeps {
  const data = connector();
  const now = (): Date => new Date();
  seed ??= s3SeedPdfStore();
  scheduler ??= eventBridgeScheduler();
  return {
    data,
    store: s3MailStore({ inbound: () => readLinked(INBOUND_MAIL_SIM_LINK, PrefixedBucket) }),
    email: stageEmailClient(options.log, data),
    seed,
    resolveThread: (address) => resolveThread({ operations: data.operations, world: data.world, threadKey: subkey("thread"), now }, address),
    emailHash: (address) => emailHash(subkey("email-hash"), address),
    now,
    scheduler,
    log: options.log,
  };
}
