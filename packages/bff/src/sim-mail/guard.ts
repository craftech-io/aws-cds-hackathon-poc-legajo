// The guard of `SimMail`, before anything else (docs/architecture-integrations.md §3 "Protecciones",
// docs/architecture.md §13): the simulator only acts on mail we sent ourselves. In this order:
//
//   1. exactly one recipient, a mailbox of `sim.legajo.demo.craftech.io`;
//   2. `dmarcVerdict PASS` (DMARC `p=reject` on our two domains: nobody else passes it);
//   3. one unambiguous author (the same single mailbox in SES's headers and `commonHeaders.from`) that
//      is an operation's thread address (`op-*@legajo…`) or `avisos@legajo…`;
//   4. the `Message-ID` is `<SesMessageId@email.amazonses.com>` and that SES id is the
//      `providerMessageId` of an outbound EMAIL `Message` of `Conversations` (GSI1) sent by that author
//      to exactly this mailbox.
//
// Only then may `X-Legajo-Operation` and `X-Legajo-Request` be read, as data of a request we know is
// ours, and the raw MIME has to agree (`confirmMime`). Anything else is discarded as `SIM_UNTRUSTED`:
// no reply, no `MailboxMessage`, no timer; the metric `SimUntrusted` counts it, the firm that owns the
// mailbox (its `ADDR#` claim) gets one audit row, and when the mail is ours by DMARC and carries an
// `X-Legajo-Mail-Id` (the `QaDriver`'s `email.inject`, SC-15/10) its pending item is closed with
// `PROBE#MAIL#` `SIM_UNTRUSTED`. A third party writing to the public MX can make the simulator answer
// nothing, store nothing and move no world.
import { NOTICES_ADDRESS, SIM_MAIL_DOMAIN, parseThreadAddress } from "@legajo/shared";
import { countMetric } from "../channels/adapter";
import { namesOnly, parseMessageIds, parseReceivedAddress, sesMessageIdOf, singleAuthor } from "../channels/email/address";
import type { ParsedMail } from "../channels/email/mime";
import { MAIL_ID_HEADER, type PendingDeps, closeMailPending, ownMailRef } from "../channels/email/pending";
import { type ReceivedMail, type SesMail, eventHeader } from "../channels/email/receipt";
import type { Connector } from "../connector/connector";
import type { Message } from "../domain/conversations";
import { simNowOf } from "../lib/clock";
import type { Logger } from "../lib/log";
import { SIM_AUDIT_ACTIONS, SIM_UNTRUSTED_METRIC, type UntrustedCause } from "./config";

export interface GuardDeps {
  readonly data: Pick<Connector, "conversations" | "parties" | "audit" | "world" | "runtime">;
  /** Keyed hash of an address (`email-hash` subkey): the key of the `ADDR#` claim of a mailbox. */
  readonly emailHash: (address: string) => string;
  /** Real clock. */
  readonly now: () => Date;
  readonly log: Logger;
}

/** A mail proven ours: who wrote it, to which mailbox, and the outbound message it is. */
export interface VerifiedMail {
  readonly recipient: string;
  readonly author: string;
  readonly providerMessageId: string;
  /** `<providerMessageId@email.amazonses.com>`: what a reply puts in `In-Reply-To`. */
  readonly rfcMessageId: string;
  readonly outbound: Message;
}

export type GuardVerdict = { readonly trusted: true; readonly mail: VerifiedMail } | { readonly trusted: false; readonly cause: UntrustedCause; readonly recipient?: string; readonly author?: string };

/** The single recipient of the receipt, lower-cased and strictly parsed, when it is a simulated mailbox. */
export function recipientOf(received: ReceivedMail): string | undefined {
  if (received.receipt.recipients.length !== 1) return undefined;
  const parsed = parseReceivedAddress(received.receipt.recipients[0] ?? "");
  return parsed.ok && parsed.value.domain === SIM_MAIL_DOMAIN ? parsed.value.address : undefined;
}

/** The one author as SES saw it: one `From` with one mailbox, named alone by `commonHeaders.from`. */
export function authorOf(mail: SesMail): string | undefined {
  if (mail.headersTruncated) return undefined;
  const author = singleAuthor(eventHeader(mail, "from"));
  return author !== undefined && namesOnly(mail.commonHeaders.from ?? [], author) ? author : undefined;
}

function isOurSender(author: string): boolean {
  return author === NOTICES_ADDRESS || parseThreadAddress(author) !== undefined;
}

/** Steps 1-4. Reads `Conversations` only once the first three passed. */
export async function verifyOwnMail(received: ReceivedMail, deps: Pick<GuardDeps, "data">): Promise<GuardVerdict> {
  const recipient = recipientOf(received);
  if (recipient === undefined) return { trusted: false, cause: "RECIPIENT" };
  if (received.receipt.dmarcVerdict.status !== "PASS") return { trusted: false, cause: "DMARC", recipient };
  const author = authorOf(received.mail);
  if (author === undefined || !isOurSender(author)) return { trusted: false, cause: "FROM", recipient, ...(author === undefined ? {} : { author }) };
  const ids = parseMessageIds(received.mail.commonHeaders.messageId);
  const rfcMessageId = ids.length === 1 ? ids[0] : undefined;
  const providerMessageId = rfcMessageId === undefined ? undefined : sesMessageIdOf(rfcMessageId);
  if (rfcMessageId === undefined || providerMessageId === undefined) return { trusted: false, cause: "MESSAGE_ID", recipient, author };
  const outbound = await deps.data.conversations.findMessageByProviderId(providerMessageId);
  const matches = outbound !== undefined && outbound.direction === "OUT" && outbound.channel === "EMAIL" && outbound.to.toLowerCase() === recipient && outbound.from.toLowerCase() === author;
  if (!matches) return { trusted: false, cause: "MESSAGE_ID", recipient, author };
  return { trusted: true, mail: { recipient, author, providerMessageId, rfcMessageId, outbound } };
}

/** The raw MIME of a verified mail names the same single author and the same `Message-ID`. */
export function confirmMime(parsed: ParsedMail, mail: VerifiedMail): boolean {
  return parsed.from === mail.author && parsed.messageId === mail.rfcMessageId;
}

export interface UntrustedInput {
  readonly received: ReceivedMail;
  readonly cause: UntrustedCause;
  readonly recipient?: string;
  readonly author?: string;
}

/** The firm (and world) of a registered simulated mailbox, from its `ADDR#` claim. */
async function ownerOf(deps: GuardDeps, recipient: string | undefined): Promise<{ readonly firmId: string; readonly clockId?: string } | undefined> {
  if (recipient === undefined) return undefined;
  const claim = await deps.data.parties.getAddressClaim(deps.emailHash(recipient));
  if (claim === undefined) return undefined;
  return claim.clockId === undefined ? { firmId: claim.firmId } : { firmId: claim.firmId, clockId: claim.clockId };
}

/** Discard of a mail that is not ours: metric, one audit row for the mailbox's firm, and the pending closed when it is provably ours. */
export async function discardUntrusted(deps: GuardDeps, input: UntrustedInput): Promise<void> {
  const { received, cause } = input;
  const realNow = deps.now();
  countMetric(deps.log, SIM_UNTRUSTED_METRIC, { cause });
  const own = ownMailRef({ dmarcVerdict: received.receipt.dmarcVerdict.status, from: input.author ?? authorOf(received.mail), mailIdHeader: eventHeader(received.mail, MAIL_ID_HEADER)[0] });
  const owner = await ownerOf(deps, input.recipient);
  if (owner !== undefined) {
    const clock = owner.clockId === undefined ? undefined : await deps.data.world.findClock(owner.clockId);
    await deps.data.audit.record({
      firmId: owner.firmId,
      decision: "DENY",
      action: SIM_AUDIT_ACTIONS.untrusted,
      actor: "SYSTEM",
      reason: cause,
      refs: own === undefined ? {} : { mailId: own.mailId },
      ...(owner.clockId === undefined ? {} : { clockId: owner.clockId }),
      ...(clock === undefined ? {} : { atSim: simNowOf(clock, realNow.getTime()).toISOString() }),
      atReal: realNow.toISOString(),
      correlationId: deps.log.correlationId,
    });
  }
  if (own !== undefined) {
    const pending: PendingDeps = { world: deps.data.world, runtime: deps.data.runtime, now: deps.now };
    await closeMailPending(pending, { ...own, outcome: "SIM_UNTRUSTED", reason: "SIM_UNTRUSTED", awaiting: "SIMMAIL" });
  }
}
