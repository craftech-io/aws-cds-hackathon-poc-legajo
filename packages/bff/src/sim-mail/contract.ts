// What `SimMail` accepts besides the SES receipt event of its rule `sim-poc` (docs/tool-catalog.md,
// `sim_reply`), validated with zod at the edge:
//
//   - `TIMER`: a `TIMER#SIM_REPLY#<id>` is due. The timers module's dispatcher (`ScheduleDispatch` for a
//     schedule, `advance_clock` and "Disparar ahora" for the clock) hands it over as a
//     `SimReplyHandoff` (timers/events.ts): `{clockId, operationId, timerKey, dueAtSim, version,
//     firmId, firedBy, eventAtSim}`. `action: "sim_reply"` and `mode: "TIMER"` may name it explicitly
//     (`simReplyInvocation`); `firmId` and `eventAtSim` default to the clock's firm and `dueAtSim`.
//   - `SEND_NOW`: the `QaDriver`'s `supplier.sendNow` (FL-058, FL-069): the supplier's registered
//     mailbox writes to its operation's thread address without a pending request. QA worlds only.
//
// Both answer synchronously with what happened; an asynchronous invocation ignores the answer.
import { z } from "zod";
import { ClockId, DocType, FirmId, OperationId, TimerFiredBy } from "@legajo/shared";
import { MAIL_ID_PATTERN } from "../channels/email/pending";
import { ZonedInstant } from "../domain/common";
import { parseTimerKey } from "../domain/timers";

const TimerKey = z.string().refine((value) => parseTimerKey(value)?.kind === "SIM_REPLY", "expected TIMER#SIM_REPLY#<timerId>");

export const SimReplyTimerInvocation = z
  .object({
    action: z.literal("sim_reply").optional(),
    mode: z.literal("TIMER").optional(),
    clockId: ClockId,
    operationId: OperationId,
    timerKey: TimerKey,
    dueAtSim: ZonedInstant,
    /** Version the schedule (or the clock) saw; a SCHEDULED timer at another version is a stale schedule. */
    version: z.number().int().min(1),
    firedBy: TimerFiredBy.default("SCHEDULER"),
    /** The world's firm (the dispatcher knows it); read from the clock when absent. */
    firmId: FirmId.optional(),
    /** `dueAtSim`, or the world's now for "Disparar ahora". */
    eventAtSim: ZonedInstant.optional(),
  })
  .strict();
export type SimReplyTimerInvocation = z.output<typeof SimReplyTimerInvocation>;

export const SendNowInvocation = z
  .object({
    action: z.literal("sim_reply"),
    mode: z.literal("SEND_NOW"),
    clockId: ClockId,
    operationId: OperationId,
    docTypes: z.array(DocType).min(1).max(3),
    /** Template version of every PDF (`Seed/pdfs/<templateOperation>/<docType>-v<version>.pdf`). */
    version: z.number().int().min(1).max(9),
    body: z.string().trim().min(1).max(2_000).optional(),
    /** Derived by the `QaDriver` from the step's idempotency key; `mail.outcome` waits on it. */
    mailId: z.string().regex(MAIL_ID_PATTERN),
  })
  .strict();
export type SendNowInvocation = z.output<typeof SendNowInvocation>;

export const SimMailInvocation = z.union([SendNowInvocation, SimReplyTimerInvocation]);
export type SimMailInvocation = z.output<typeof SimMailInvocation>;

/** The input of a schedule (docs/architecture.md §8) and what fired it, as `SimMail` takes it. */
export interface DueSimReply {
  readonly clockId: string;
  readonly operationId: string;
  readonly timerKey: string;
  readonly dueAtSim: string;
  readonly version: number;
  readonly firedBy?: z.input<typeof TimerFiredBy>;
  readonly firmId?: string;
  readonly eventAtSim?: string;
}

/** For `ScheduleDispatch` and `advance_clock`: the invocation of a due `TIMER#SIM_REPLY#`. */
export function simReplyInvocation(due: DueSimReply): SimReplyTimerInvocation {
  return SimReplyTimerInvocation.parse({ action: "sim_reply", mode: "TIMER", ...due });
}

/** True for the `SEND_NOW` arm (the timer arm never carries `docTypes`). */
export function isSendNow(invocation: SimMailInvocation): invocation is SendNowInvocation {
  return invocation.mode === "SEND_NOW";
}

/** What a `TIMER` or `SEND_NOW` invocation did. */
export type SimReplyResult =
  | { readonly status: "SENT"; readonly mailId: string; readonly providerMessageId: string }
  | { readonly status: "SKIPPED"; readonly reason: string }
  | { readonly status: "REFUSED"; readonly code: "INVALID" | "RECIPIENT_NOT_ALLOWED" | "FORBIDDEN" | "NOT_FOUND"; readonly reason: string };

/** True for the receipt event of SES's rule (`Records[0].eventSource = aws:ses`). */
export function isReceiptEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null || !("Records" in event)) return false;
  const records = (event as { Records?: unknown }).Records;
  return Array.isArray(records) && records.some((record) => typeof record === "object" && record !== null && (record as { eventSource?: unknown }).eventSource === "aws:ses");
}
