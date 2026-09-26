// What every rule reads, computed once per evaluation: the parsed input, the instant in simulated and
// real time, who the message goes to, the time base of the WhatsApp window and whether the send is
// a reply to the importer (window.ts). The builders of a rule's result live in checks.ts.
import type { ChannelMode } from "@legajo/shared";
import type { HolidayCalendar } from "../services/holidays";
import { argentinaHolidays } from "./holidays";
import { TO_IMPORTER, TO_SUPPLIER, type Route } from "./kinds";
import type { EvaluationMode, HistoryMessage, ParsedPolicyInput } from "./types";
import { replyOf } from "./window";

/** The 24-hour window runs on real time when WhatsApp is live (Meta measures it) and on the world's clock otherwise. */
export type TimeBase = "SIM" | "REAL";

export interface PolicyContext {
  readonly mode: EvaluationMode;
  readonly input: ParsedPolicyInput;
  readonly message: ParsedPolicyInput["message"];
  readonly operation: ParsedPolicyInput["operation"];
  readonly simNow: Date;
  readonly realNow: Date;
  readonly route: Route;
  readonly toImporterByWhatsApp: boolean;
  readonly toSupplierByEmail: boolean;
  readonly windowBase: TimeBase;
  readonly holidays: HolidayCalendar | undefined;
  /** The counterpart's messages, without the judged message itself. */
  readonly history: readonly HistoryMessage[] | undefined;
  /** `undefined` when there is no history to prove it either way. */
  readonly reply: boolean | undefined;
}

function timeBaseOf(mode: ChannelMode): TimeBase {
  return mode === "live" ? "REAL" : "SIM";
}

export function buildContext(input: ParsedPolicyInput, mode: EvaluationMode): PolicyContext {
  const { message } = input;
  const route: Route = `${message.counterpart}:${message.channel}`;
  const history = input.history?.filter((entry) => entry.messageId !== message.messageId);
  const base = {
    mode,
    input,
    message,
    operation: input.operation,
    simNow: input.clock.simNow,
    realNow: input.clock.realNow,
    route,
    toImporterByWhatsApp: route === TO_IMPORTER,
    toSupplierByEmail: route === TO_SUPPLIER,
    windowBase: timeBaseOf(input.modes.whatsapp),
    holidays: input.holidays === undefined ? undefined : argentinaHolidays(input.holidays),
    history,
  };
  return { ...base, reply: replyOf(base) };
}
