// The rules of check (b) that depend on when a message went out and on what went before it
// (docs/design-brief.md §5.7): business hours of each side, one request or reminder per contact and
// simulated day, and the WhatsApp 24-hour window. Their facts are the send's instant, the business
// hours of Buenos Aires (with the national holidays of `Reference`) and of the supplier's zone, and
// the counterpart's other messages, all as they were at `sentAtSim` (facts.ts rebuilds them).
import type { ContactPolicyRuleId, MessageKind } from "@legajo/shared";
import type { Message } from "../domain/conversations";
import { type BusinessHours, isBusinessOpen, localDateOf } from "../services/business-hours";

/** Statuses of a message that left the building (queued, deferred or failed ones never did). */
const SENT_STATUSES: ReadonlySet<Message["status"]> = new Set(["SENT", "DELIVERED", "READ", "DELAYED", "BOUNCED", "COMPLAINED"]);

export function wentOut(message: Pick<Message, "direction" | "status">): boolean {
  return message.direction === "OUT" && SENT_STATUSES.has(message.status);
}

/** Kinds `CP-ONE-PER-DAY` counts. */
const ONCE_A_DAY_KINDS: readonly MessageKind[] = ["DOCS_REQUEST", "REMINDER"];

/** Kinds that only ever answer a message of the importer (exempt from `CP-HOURS-AR`). */
const ANSWER_KINDS: readonly MessageKind[] = ["REPLY", "OPT_OUT_CONFIRMATION", "OPERATION_CHOICE"];

const WINDOW_MS = 24 * 3_600_000;

export type HistoryMessage = Pick<Message, "messageId" | "direction" | "channel" | "counterpart" | "kind" | "status" | "sentAtSim" | "sentAtReal">;

export interface TimeFacts {
  readonly message: HistoryMessage & Pick<Message, "template" | "simulated">;
  /** The send answered a message of the importer (its ALLOW decision's trigger). */
  readonly answersImporter?: boolean;
  /** Buenos Aires hours with the national holidays; the rules of the importer's side skip without them. */
  readonly importerHours?: BusinessHours;
  /** Hours of the supplier's zone; the rules of the supplier's side skip without them. */
  readonly supplierHours?: BusinessHours;
  /** The counterpart's messages around the send (any operation); the frequency and window rules skip without them. */
  readonly history?: readonly HistoryMessage[];
}

export interface TimeBreach {
  readonly ruleId: ContactPolicyRuleId;
  readonly detail: string;
}

function isToImporterByWhatsApp(message: TimeFacts["message"]): boolean {
  return message.channel === "WHATSAPP" && message.counterpart === "IMPORTER";
}

function isToSupplierByEmail(message: TimeFacts["message"]): boolean {
  return message.channel === "EMAIL" && message.counterpart === "SUPPLIER";
}

function hoursArBreach(facts: TimeFacts): TimeBreach | undefined {
  const { message } = facts;
  if (!isToImporterByWhatsApp(message) || facts.importerHours === undefined) return undefined;
  if (facts.answersImporter === true || (message.kind !== undefined && ANSWER_KINDS.includes(message.kind))) return undefined;
  if (isBusinessOpen(new Date(message.sentAtSim), facts.importerHours)) return undefined;
  return { ruleId: "CP-HOURS-AR", detail: "a proactive WhatsApp went out of Buenos Aires business hours" };
}

function hoursSupplierBreach(facts: TimeFacts): TimeBreach | undefined {
  const { message } = facts;
  if (!isToSupplierByEmail(message) || facts.supplierHours === undefined) return undefined;
  if (isBusinessOpen(new Date(message.sentAtSim), facts.supplierHours)) return undefined;
  return { ruleId: "CP-HOURS-SUPPLIER", detail: "an email went out of the supplier's business hours" };
}

/** Before `message` in the order the pipeline wrote them (same instant: by id, which is a ULID). */
function isEarlier(other: HistoryMessage, message: HistoryMessage): boolean {
  const delta = Date.parse(other.sentAtSim) - Date.parse(message.sentAtSim);
  return delta < 0 || (delta === 0 && other.messageId < message.messageId);
}

function onePerDayBreach(facts: TimeFacts): TimeBreach | undefined {
  const { message, history } = facts;
  if (history === undefined || message.kind === undefined || !ONCE_A_DAY_KINDS.includes(message.kind)) return undefined;
  const hours = message.counterpart === "IMPORTER" ? facts.importerHours : facts.supplierHours;
  if (hours === undefined) return undefined;
  const day = localDateOf(new Date(message.sentAtSim), hours.timeZone);
  const earlier = history.some(
    (other) =>
      other.messageId !== message.messageId &&
      wentOut(other) &&
      other.kind !== undefined &&
      ONCE_A_DAY_KINDS.includes(other.kind) &&
      isEarlier(other, message) &&
      localDateOf(new Date(other.sentAtSim), hours.timeZone) === day,
  );
  return earlier ? { ruleId: "CP-ONE-PER-DAY", detail: "a second request or reminder reached the same contact on one simulated day" } : undefined;
}

function whatsAppWindowBreach(facts: TimeFacts): TimeBreach | undefined {
  const { message, history } = facts;
  if (!isToImporterByWhatsApp(message) || history === undefined || message.template !== undefined) return undefined;
  // Meta measures the window in real time; a simulated channel follows the world's clock.
  const instantOf = (item: HistoryMessage): number => Date.parse(message.simulated ? item.sentAtSim : item.sentAtReal);
  const sentAt = instantOf(message);
  const open = history.some((other) => {
    if (other.direction !== "IN" || other.channel !== "WHATSAPP" || other.counterpart !== "IMPORTER") return false;
    const at = instantOf(other);
    return at <= sentAt && sentAt - at < WINDOW_MS;
  });
  return open ? undefined : { ruleId: "CP-WA-24H", detail: "free text went out with no importer message in the last 24 hours" };
}

/** Time rules, in the engine's order (docs/design-brief.md §5.7). */
export const TIME_RULES = ["CP-HOURS-AR", "CP-HOURS-SUPPLIER", "CP-ONE-PER-DAY", "CP-WA-24H"] as const satisfies readonly ContactPolicyRuleId[];

export function timeBreaches(facts: TimeFacts): TimeBreach[] {
  return [hoursArBreach, hoursSupplierBreach, onePerDayBreach, whatsAppWindowBreach].flatMap((rule) => {
    const breach = rule(facts);
    return breach === undefined ? [] : [breach];
  });
}
