// Lambda entry of `ChannelEvents`: the target of the default-bus rule of infra/messaging-email.ts, which
// carries the SES delivery events of the configuration set `…-email-poc` (docs/architecture-
// integrations.md §1 "Eventos" and §8). Two kinds of mail share that set:
//
//   - a mail the system sent for an operation (a `Message OUT` in `Conversations`, tagged with its
//     `messageId`): channels/email/events.ts `processSesEvent` enqueues `EMAIL_EVENT` (`inFlight` first)
//     and only then closes its `SES_EVENT` pending mail; a tagged mail not recorded yet is retried;
//   - an account email of Cognito or the lead notice (no `Message` in `Conversations`): each recipient
//     of a permanent bounce or a complaint goes to channels/email/mail-status.ts `markMailStatus`
//     (`Runtime/MAILSTATUS#<emailHash>` with the `lead-email` subkey, `RL#MAILBAD#<hour>`, the breaker
//     `MAILBREAKER`, ADR-0015 §3.2). Neither the address nor its hash is logged; `Leads` is never touched.
//
// An event that does not parse is dropped and logged without its content.
import { processSesEvent, parseSesEvent, type ChannelEventsDeps, type SesEventOutcome, type SesMailEvent } from "../channels/email/events";
import { stageChannelEventsDeps } from "../channels/email/adapter";
import { type AccountMailEvent, type MailStatusDeps, markMailStatus } from "../channels/email/mail-status";
import { connector, tableClient } from "../connector/index";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";
import { subkey } from "../lib/secrets";
import { linkedQueueSink } from "../worker/sink";

export type ChannelEventsOutcome = SesEventOutcome | "ACCOUNT_MAIL_MARKED" | "ACCOUNT_MAIL_IGNORED" | "INVALID";

export interface ChannelEventsEntryDeps {
  readonly channel: ChannelEventsDeps;
  readonly mailStatus: MailStatusDeps;
}

/** `AccountMailEvent.recipients` takes at most 50 addresses per call. */
const RECIPIENTS_PER_CALL = 50;

/** The issue `markMailStatus` records for an account email: a permanent bounce or a complaint only. */
export function accountMailIssue(event: SesMailEvent): AccountMailEvent["kind"] | undefined {
  if (event.type === "COMPLAINT") return "COMPLAINT";
  if (event.type === "BOUNCE" && event.bounceType === "Permanent") return "BOUNCE";
  return undefined;
}

/** A mail of the configuration set that no `Message OUT` records: an account email or the lead notice. */
async function isAccountMail(deps: ChannelEventsEntryDeps, event: SesMailEvent): Promise<boolean> {
  if (event.tags.messageId !== undefined) return false;
  return (await deps.channel.conversations.findMessageByProviderId(event.sesMessageId)) === undefined;
}

async function markAccountMail(deps: ChannelEventsEntryDeps, event: SesMailEvent, log: Logger): Promise<ChannelEventsOutcome> {
  const kind = accountMailIssue(event);
  const recipients = event.recipients.filter((recipient) => recipient.length >= 3 && recipient.length <= 320);
  if (kind === undefined || recipients.length === 0) {
    log.info("channel_events.account_mail", { type: event.type, marked: 0 });
    return "ACCOUNT_MAIL_IGNORED";
  }
  let marked = 0;
  for (let start = 0; start < recipients.length; start += RECIPIENTS_PER_CALL) {
    const result = await markMailStatus(deps.mailStatus, { kind, recipients: recipients.slice(start, start + RECIPIENTS_PER_CALL) });
    marked += result.marked;
  }
  log.info("channel_events.account_mail", { type: event.type, marked });
  return "ACCOUNT_MAIL_MARKED";
}

export type ChannelEventsHandler = (event: unknown) => Promise<{ readonly status: ChannelEventsOutcome }>;

export function createChannelEventsHandler(depsFor: (log: Logger) => ChannelEventsEntryDeps, newLog: () => Logger = () => createLogger({ correlationId: newCorrelationId(), bindings: { service: "channel-events" } })): ChannelEventsHandler {
  return async (event) => {
    const log = newLog();
    let parsed: SesMailEvent | undefined;
    try {
      parsed = parseSesEvent(event);
    } catch {
      log.warn("channel_events.invalid_event");
      return { status: "INVALID" };
    }
    if (parsed === undefined) return { status: "IGNORED" };
    const deps = depsFor(log);
    if (await isAccountMail(deps, parsed)) return { status: await markAccountMail(deps, parsed, log) };
    return { status: await processSesEvent(event, deps.channel) };
  };
}

function stageDeps(log: Logger): ChannelEventsEntryDeps {
  const data = connector();
  return {
    channel: stageChannelEventsDeps({ log, data, events: linkedQueueSink(data.world) }),
    mailStatus: { client: tableClient(), leadEmailKey: subkey("lead-email"), log, now: () => new Date() },
  };
}

export const handler: ChannelEventsHandler = createChannelEventsHandler(stageDeps);
