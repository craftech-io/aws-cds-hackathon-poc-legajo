// Every reply of the simulator that is not immediate is a `TIMER#SIM_REPLY#<timerId>` of the
// operation (docs/architecture.md §8), armed through the timers module: with the world PAUSED,
// "Avanzar" fires it; with the world RUNNING, its real schedule does (`ScheduleDispatch`). Either way
// it reaches SimMail as a hand-off (supplier-simulator.ts `fireSimReply`). Its payload is what the
// reply needs, validated with zod on the way in and on the way out. A timer sends at most one reply:
// `Runtime/IDEMP#SIM_REPLY#<operationId>#<timerKey>` is claimed before the send.
import { z } from "zod";
import { ConnectorError, DocType, MessageId, MessageKind, SupplierBehaviour } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import { EmailAddress } from "../domain/common";
import type { Operation } from "../domain/operations";
import { type Timer, timerKeyOf } from "../domain/timers";
import { sha256Hex } from "../lib/crypto";
import { type TimerDeps, armTimer } from "../timers/timers";
import { SIM_REPLY_IDEMPOTENCY_SOURCE } from "./config";

const MessageIdHeader = z.string().regex(/^<[^<>\s@]{1,250}@[^<>\s@]{1,250}>$/);

/** The outbound mail a reply answers, as the simulator received it. */
export const AnsweredMail = z
  .object({
    /** Our `Message OUT` the received mail was verified against. */
    messageId: MessageId,
    /** `<providerMessageId@email.amazonses.com>`: the reply's `In-Reply-To`. */
    rfcMessageId: MessageIdHeader,
    references: z.array(MessageIdHeader).max(50).default([]),
    subject: z.string().max(998),
    /** The operation's thread address: where the reply goes. */
    threadAddress: EmailAddress,
    /** The supplier's mailbox that received it: the reply's `From`. */
    mailbox: EmailAddress,
  })
  .strict();
export type AnsweredMail = z.output<typeof AnsweredMail>;

export const SimReplyPayload = z
  .object({
    phase: z.enum(["REPLY", "FOLLOW_UP"]),
    behaviour: SupplierBehaviour,
    request: z.object({ kind: MessageKind, docTypes: z.array(DocType).max(3) }).strict(),
    answered: AnsweredMail,
  })
  .strict();
export type SimReplyPayload = z.output<typeof SimReplyPayload>;

/** Deterministic id: a redelivery of the same mail finds its timer instead of creating another. */
export function simReplyTimerId(sesMessageId: string, phase: SimReplyPayload["phase"]): string {
  return `sr-${sha256Hex(`${sesMessageId}#${phase}`).slice(0, 24)}`;
}

export interface NewSimReply {
  readonly operation: Operation;
  readonly timerId: string;
  readonly dueAtSim: string;
  readonly payload: SimReplyPayload;
}

/**
 * `TIMER#SIM_REPLY#<timerId>` SCHEDULED in its world's GSI3 through the timers module (`armTimer`: the
 * real schedule when the world runs, a direct dispatch when it is 60 s away or less, nothing when it is
 * paused). Idempotent by id: a redelivered mail finds the timer it already armed.
 */
export async function scheduleSimReply(deps: TimerDeps, input: NewSimReply): Promise<Timer> {
  const { operation } = input;
  try {
    const armed = await armTimer(
      { operationId: operation.operationId, clockId: operation.clockId, kind: "SIM_REPLY", timerId: input.timerId, dueAtSim: input.dueAtSim, reason: `${input.payload.behaviour}:${input.payload.phase}`, payload: SimReplyPayload.parse(input.payload) },
      deps,
    );
    return armed.timer;
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    return deps.data.timers.getTimer(operation.operationId, timerKeyOf("SIM_REPLY", input.timerId));
  }
}

export type ReplyClaim = { readonly ok: true; readonly payload: SimReplyPayload } | { readonly ok: false; readonly reason: "PAYLOAD_INVALID" | "ALREADY_SENT" };

/**
 * The payload of a due timer, and the right to send its one reply: `Runtime/IDEMP#SIM_REPLY#<operationId>#<timerKey>`
 * is claimed before the send (at most once, whoever fires it and however often).
 */
export async function claimReplyOnce(deps: { readonly data: Pick<Connector, "runtime">; readonly now: () => Date }, timer: Timer): Promise<ReplyClaim> {
  const payload = SimReplyPayload.safeParse(timer.payload);
  if (!payload.success) return { ok: false, reason: "PAYLOAD_INVALID" };
  const timerKey = timerKeyOf(timer.kind, timer.timerId);
  const first = await deps.data.runtime.claimIdempotency({ source: SIM_REPLY_IDEMPOTENCY_SOURCE, id: `${timer.operationId}#${timerKey}`, atReal: deps.now().toISOString(), result: { timerKey } });
  return first ? { ok: true, payload: payload.data } : { ok: false, reason: "ALREADY_SENT" };
}
