// A mail to a simulated mailbox, as the receipt rule `sim-poc` delivers it (the rule's S3 action stored
// the raw MIME under `Resource.InboundMailSim.prefix` first). The order (docs/architecture-integrations.md
// §3 and docs/architecture.md §7):
//
//   1. idempotency by SES's message id (`Runtime/IDEMP#SIMMAIL#ses:<id>`): a redelivery does nothing;
//   2. the guard (guard.ts), before anything else; a mail that is not ours is discarded as
//      `SIM_UNTRUSTED`. A Cognito account email to a `qa-signup-…` mailbox of the scenario runner is not
//      ours either: it stays in the bucket for `signup.readCode` and is dropped without metric, audit
//      row or reply;
//   3. the raw MIME, which has to name the same author and `Message-ID`;
//   4. the mailbox decides: a firm's (`estudio-…`) keeps a `MailboxMessage`; a supplier's keeps one too
//      and runs the supplier simulator; anything else, or an outbound of another kind, is a discard;
//   5. only after that effect is on record, `PROBE#MAIL#<mailId>` with the outcome and the pending item
//      of the mail (`awaiting SIMMAIL`) closed.
import { type MailAwaiting } from "@legajo/shared";
import { parseMime } from "../channels/email/mime";
import { MAIL_ID_HEADER, closeMailPending, ownMailRef } from "../channels/email/pending";
import { type ReceivedMail, eventHeader, parseReceiptEvent } from "../channels/email/receipt";
import type { MailStore } from "../channels/email/store";
import type { MailOutcome } from "../domain/runtime";
import { simNowOf } from "../lib/clock";
import type { Logger } from "../lib/log";
import { SIM_MAIL_IDEMPOTENCY_SOURCE, type UntrustedCause } from "./config";
import { type GuardDeps, type VerifiedMail, authorOf, confirmMime, discardUntrusted, verifyOwnMail } from "./guard";
import { mailboxKind } from "./mailboxes";
import { storeMailboxMessage } from "./mailbox";
import { type SimulatorDeps, onSupplierMail } from "./supplier-simulator";

export interface SimMailDeps extends SimulatorDeps, Omit<GuardDeps, "data" | "log"> {
  readonly data: SimulatorDeps["data"] & GuardDeps["data"];
  /** Raw MIME of the `sim` route of the mail bucket. */
  readonly store: Pick<MailStore, "readRaw">;
  readonly log: Logger;
}

export interface SimMailReceipt {
  readonly outcome: MailOutcome | "DUPLICATE" | "IGNORED";
  readonly reason?: string;
  readonly operationId?: string;
}

const AWAITING: MailAwaiting = "SIMMAIL";

/** Every recipient is a sign-up mailbox of the scenario runner: a Cognito account email. */
function isAccountMail(received: ReceivedMail): boolean {
  const recipients = received.receipt.recipients.map((recipient) => recipient.trim().toLowerCase());
  return recipients.length > 0 && recipients.every((recipient) => mailboxKind(recipient) === "ACCOUNT");
}

/** SES's receipt timestamp when it is a valid instant, else the real now. */
function receivedAt(received: ReceivedMail, now: Date): string {
  const at = Date.parse(received.mail.timestamp);
  return Number.isNaN(at) ? now.toISOString() : new Date(at).toISOString();
}

export async function receiveSimMail(event: unknown, deps: SimMailDeps): Promise<SimMailReceipt> {
  const received = parseReceiptEvent(event);
  const sesMessageId = received.mail.messageId;
  const log = deps.log.child({ channel: "EMAIL", service: "sim-mail", sesMessageId });
  const scoped = { ...deps, log };
  const idempotencyId = `ses:${sesMessageId}`;
  if ((await deps.data.runtime.getIdempotency(SIM_MAIL_IDEMPOTENCY_SOURCE, idempotencyId)) !== undefined) {
    log.info("duplicate simulated mailbox mail ignored");
    return { outcome: "DUPLICATE" };
  }
  const claim = async (result: SimMailReceipt): Promise<SimMailReceipt> => {
    await deps.data.runtime.claimIdempotency({ source: SIM_MAIL_IDEMPOTENCY_SOURCE, id: idempotencyId, atReal: deps.now().toISOString(), result: { ...result } });
    return result;
  };
  const untrusted = async (cause: UntrustedCause, recipient?: string, author?: string): Promise<SimMailReceipt> => {
    await discardUntrusted(scoped, { received, cause, ...(recipient === undefined ? {} : { recipient }), ...(author === undefined ? {} : { author }) });
    log.warn("mail to a simulated mailbox discarded", { outcome: "SIM_UNTRUSTED", cause });
    return claim({ outcome: "SIM_UNTRUSTED", reason: cause });
  };

  // 2. The guard, before anything else.
  const verdict = await verifyOwnMail(received, deps);
  if (!verdict.trusted) {
    if (isAccountMail(received)) {
      log.info("account email to a sign-up mailbox kept for the scenario runner, not answered", { outcome: "SIM_UNTRUSTED", cause: "ACCOUNT_MAIL" });
      return { outcome: "IGNORED", reason: "ACCOUNT_MAIL" };
    }
    return untrusted(verdict.cause, verdict.recipient, verdict.author);
  }
  const { mail } = verdict;

  // 3. The raw MIME has to agree with what SES saw.
  const parsed = await parseMime(await deps.store.readRaw(sesMessageId));
  if (!confirmMime(parsed, mail)) return untrusted("MIME_MISMATCH", mail.recipient, mail.author);

  // 4. The mailbox decides, and the outbound it answers has to agree.
  const kind = mailboxKind(mail.recipient);
  const counterpart = mail.outbound.counterpart;
  if (!((kind === "FIRM" && counterpart === "FIRM") || (kind === "SUPPLIER" && counterpart === "SUPPLIER"))) return untrusted("MAILBOX_KIND", mail.recipient, mail.author);
  const realNow = deps.now();
  const simNow = simNowOf(await deps.data.world.getClock(mail.outbound.clockId), realNow.getTime()).toISOString();
  await storeMailboxMessage(deps.data, { mail, parsed, sesMessageId, receivedAtReal: receivedAt(received, realNow), receivedAtSim: simNow });
  const effect: { readonly outcome: MailOutcome; readonly reason?: string } = kind === "FIRM" ? { outcome: "MAILBOX" } : await onSupplierMail(scoped, { mail, parsed, sesMessageId, simNow });

  // 5. The pending mail closes only now.
  await closeOwnPending(scoped, received, mail, effect);
  log.info("simulated mailbox mail processed", { outcome: effect.outcome, reason: effect.reason, operationId: mail.outbound.operationId, mailbox: kind });
  return claim({ outcome: effect.outcome, operationId: mail.outbound.operationId, ...(effect.reason === undefined ? {} : { reason: effect.reason }) });
}

async function closeOwnPending(deps: SimMailDeps, received: ReceivedMail, mail: VerifiedMail, effect: { readonly outcome: MailOutcome; readonly reason?: string }): Promise<void> {
  const own = ownMailRef({ dmarcVerdict: received.receipt.dmarcVerdict.status, from: authorOf(received.mail), mailIdHeader: eventHeader(received.mail, MAIL_ID_HEADER)[0] });
  if (own === undefined) return;
  await closeMailPending(
    { world: deps.data.world, runtime: deps.data.runtime, now: deps.now },
    { ...own, outcome: effect.outcome, operationId: mail.outbound.operationId, awaiting: AWAITING, ...(effect.reason === undefined ? {} : { reason: effect.reason }) },
  );
}
