// Points the WhatsApp Business Account's events at the stage's inbound topic
// `aws-cds-hackathon-poc-legajo-wa-inbound` (docs/architecture-integrations.md §4, docs/pending.md P-01
// step 6). A WABA has one event destination; the script is idempotent: a WABA already pointing at the
// topic is left as it is. Runs inside `sst shell` once the WABA is connected; without `--apply` it only
// prints what it would do.
//
//   npm run channels:waba-event-destination -- --stage poc
//   npm run channels:waba-event-destination -- --stage poc --apply
//
// SDK commands, checked in the installed `@aws-sdk/client-socialmessaging` `.d.ts` before use:
// `GetLinkedWhatsAppBusinessAccountCommand {id}` → `account{arn, eventDestinations[{eventDestinationArn,
// roleArn?}]}` and `PutWhatsAppBusinessAccountEventDestinationsCommand {id, eventDestinations}` → `{}`.
// The topic's account and region come from the linked WABA's ARN, so nothing is typed by hand.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GetLinkedWhatsAppBusinessAccountCommand, PutWhatsAppBusinessAccountEventDestinationsCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { awsClientConfig } from "@legajo/bff/lib/clients";
import { STAGE_REGION } from "@legajo/bff/public-web/presign";
import { parseFlags } from "./cli-args";

export const STAGE = "poc";
/** `<app>-wa-inbound` (infra/messaging-whatsapp.ts `WHATSAPP_TOPIC_NAME`). */
export const TOPIC_NAME = "aws-cds-hackathon-poc-legajo-wa-inbound";

export interface DestinationArgs {
  stage?: string;
  apply?: boolean;
}

export function parseDestinationArgs(argv: readonly string[]): DestinationArgs {
  const args: DestinationArgs = {};
  parseFlags(argv, { "--stage": (value) => void (args.stage = value()), "--apply": () => void (args.apply = true) });
  if (args.stage !== STAGE) throw new RangeError(`--stage ${STAGE} is required (the only stage)`);
  return args;
}

/** `arn:aws:sns:<region>:<account>:<topic>` from the WABA's own ARN (`arn:aws:social-messaging:<region>:<account>:waba/<id>`). */
export function topicArnFor(wabaArn: string): string {
  const [, partition, service, region, account] = wabaArn.split(":");
  if (service !== "social-messaging" || !region || !/^\d{12}$/.test(account ?? "")) throw new RangeError("unexpected ARN of the linked WABA");
  return `arn:${partition ?? "aws"}:sns:${region}:${account ?? ""}:${TOPIC_NAME}`;
}

export interface LinkedWaba {
  readonly arn: string;
  readonly eventDestinations: ReadonlyArray<{ readonly eventDestinationArn: string }>;
}

export interface DestinationDeps {
  get(wabaId: string): Promise<LinkedWaba>;
  put(wabaId: string, topicArn: string): Promise<void>;
  wabaId(): string | undefined;
  report(line: string): void;
}

export type DestinationOutcome = "ALREADY_SET" | "WOULD_SET" | "SET";

export async function runDestination(args: DestinationArgs, deps: DestinationDeps): Promise<DestinationOutcome> {
  const wabaId = deps.wabaId();
  if (wabaId === undefined) throw new RangeError("the WABA is not connected (secret WabaId is not-connected): close docs/pending.md P-01 first");
  const waba = await deps.get(wabaId);
  const topicArn = topicArnFor(waba.arn);
  if (waba.eventDestinations.length === 1 && waba.eventDestinations[0]?.eventDestinationArn === topicArn) {
    deps.report(`events already go to ${TOPIC_NAME}`);
    return "ALREADY_SET";
  }
  if (!args.apply) {
    deps.report(`would send the WABA's events to ${TOPIC_NAME} (run with --apply)`);
    return "WOULD_SET";
  }
  await deps.put(wabaId, topicArn);
  deps.report(`events now go to ${TOPIC_NAME}`);
  return "SET";
}

const TIMEOUTS = { requestTimeoutMs: 10_000, connectionTimeoutMs: 2_000, maxAttempts: 4 };

async function stageDeps(): Promise<DestinationDeps> {
  const { whatsAppConnection } = await import("@legajo/bff/lib/secrets");
  const client = new SocialMessagingClient({ region: STAGE_REGION, ...awsClientConfig(TIMEOUTS) });
  return {
    async get(id) {
      const { account } = await client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id }));
      if (account?.arn === undefined) throw new Error("the WABA is not linked to this account");
      return { arn: account.arn, eventDestinations: (account.eventDestinations ?? []).map((destination) => ({ eventDestinationArn: destination.eventDestinationArn ?? "" })) };
    },
    async put(id, topicArn) {
      await client.send(new PutWhatsAppBusinessAccountEventDestinationsCommand({ id, eventDestinations: [{ eventDestinationArn: topicArn }] }));
    },
    wabaId: () => whatsAppConnection()?.wabaId,
    report: (line) => process.stdout.write(`channels:waba-event-destination: ${line}\n`),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseDestinationArgs(process.argv.slice(2));
  stageDeps()
    .then((deps) => runDestination(args, deps))
    .catch((error: unknown) => {
      process.stderr.write(`channels:waba-event-destination: ${error instanceof Error ? error.message : "failed"}\n`);
      process.exit(1);
    });
}
