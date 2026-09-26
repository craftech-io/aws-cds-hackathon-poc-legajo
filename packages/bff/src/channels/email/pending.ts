// Pending mail (docs/architecture.md §7, "Correo pendiente"): before every `SendEmail` the single SES
// client writes `Runtime/PENDING#<clockId>` · `MAIL#<mailId>` with who has to close it
// (`awaiting`): `SIMMAIL` for our simulated mailboxes, `INBOUND` for an operation's thread address,
// `SES_EVENT` for SES's mailbox simulator and the registered demo recipients. The `mailId` travels in
// `X-Legajo-Mail-Id: <mailId>; clock=<clockId>`. Whoever processes the mail first records its effect,
// then writes `PROBE#MAIL#<mailId>` with the outcome and only then deletes the pending item, so the
// world is never quiet while the mail is still in transit. A receiver reads the header only from a
// mail that is ours (`dmarcVerdict PASS` and `From` in our two domains: nobody else passes DMARC with
// `p=reject` there), and closes only a pending item whose `from` matches.
import { ClockId, type MailAwaiting, SIM_MAIL_DOMAIN, STAGE_DOMAIN } from "@legajo/shared";
import type { RuntimePort, WorldPort } from "../../connector/ports-runtime";
import type { MailOutcome } from "../../domain/runtime";
import type { MailPending } from "../../domain/world-state";
import { parseReceivedAddress } from "./address";

export const MAIL_ID_HEADER = "X-Legajo-Mail-Id";
export const MAIL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface MailRef {
  readonly mailId: string;
  readonly clockId: string;
}

/** `01JAB3C4D5E6F7G8H9J0KMNPQR; clock=GLOBAL#firm-delta`. */
export function mailIdHeaderValue(ref: MailRef): string {
  if (!MAIL_ID_PATTERN.test(ref.mailId)) throw new RangeError("invalid mail id");
  return `${ref.mailId}; clock=${ClockId.parse(ref.clockId)}`;
}

export function parseMailIdHeader(value: string | undefined): MailRef | undefined {
  const match = /^\s*([A-Za-z0-9_-]{8,64});\s*clock=(\S{1,80})\s*$/.exec(value ?? "");
  if (!match) return undefined;
  const clockId = ClockId.safeParse(match[2]);
  return clockId.success ? { mailId: match[1] ?? "", clockId: clockId.data } : undefined;
}

export interface OwnMailInput {
  readonly dmarcVerdict: string;
  /** `From` of the received mail as the sender wrote it. */
  readonly from: string | undefined;
  /** Value of `X-Legajo-Mail-Id`, if any. */
  readonly mailIdHeader: string | undefined;
}

/** The pending reference of a received mail we sent ourselves, or `undefined` when it is not provably ours. */
export function ownMailRef(input: OwnMailInput): (MailRef & { readonly from: string }) | undefined {
  if (input.dmarcVerdict !== "PASS" || input.from === undefined) return undefined;
  const from = parseReceivedAddress(input.from);
  if (!from.ok || (from.value.domain !== STAGE_DOMAIN && from.value.domain !== SIM_MAIL_DOMAIN)) return undefined;
  const ref = parseMailIdHeader(input.mailIdHeader);
  return ref === undefined ? undefined : { ...ref, from: from.value.address };
}

export interface PendingDeps {
  readonly world: Pick<WorldPort, "getMailPending" | "closeMailPending">;
  readonly runtime: Pick<RuntimePort, "putMailProbe">;
  /** Real clock of the probe's stamp and TTL. */
  readonly now: () => Date;
}

export interface CloseInput extends MailRef {
  /** `From` of the mail being closed; a pending item written for another sender is left alone. */
  readonly from: string;
  readonly outcome: MailOutcome;
  readonly reason?: string;
  readonly operationId?: string;
  /** Close only an item that waits for this receiver (`ChannelEvents` never closes a `SIMMAIL` item). */
  readonly awaiting?: MailAwaiting;
}

/**
 * Closes the pending item of a mail after its effect was recorded: `PROBE#MAIL#<mailId>` with the
 * outcome first, then the delete. `false` when there was no open item of that `from` (nothing written).
 */
export async function closeMailPending(deps: PendingDeps, input: CloseInput): Promise<boolean> {
  const pending: MailPending | undefined = await deps.world.getMailPending(input.clockId, input.mailId);
  if (pending === undefined || pending.from !== input.from) return false;
  if (input.awaiting !== undefined && pending.awaiting !== input.awaiting) return false;
  await deps.runtime.putMailProbe({
    mailId: input.mailId,
    outcome: input.outcome,
    clockId: input.clockId,
    atReal: deps.now().toISOString(),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
  });
  return deps.world.closeMailPending({ clockId: input.clockId, mailId: input.mailId, from: input.from });
}
