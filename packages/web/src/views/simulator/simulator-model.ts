// Pure rules of the phone simulator (FL-083, docs/architecture-integrations.md §4.2): which thread
// opens by default (the main story's importer, operation 4471 of the guided tour, else the first with
// unread messages), what the phone shows (what the importer sent, and only what the firm's messages
// that actually left: a deferred or queued one is not on the phone yet), the ticks of each outbound
// message, the "typing" indicator while a turn runs on one of the thread's operations, and the checks
// on a PDF before it is uploaded. No React here: simulator-model.test.ts covers it.
import { formatSimDateTime, formatTime } from "../../lib/format";
import type { WorldPending } from "../../lib/world-clock";
import { TOUR_OPERATION_NUMBER } from "../tour/steps";
import { simulatorCopy } from "./copy";
import { MAX_PDF_BYTES, type SimMessage, type SimThread } from "./simulator-api";

/** Outbound statuses that never reached the phone (still waiting, or dropped before leaving). */
const NOT_ON_PHONE: ReadonlySet<string> = new Set(["DEFERRED", "QUEUED", "DISCARDED", "QUARANTINED"]);

/** The thread to open: the one the caller asked for while it exists, else the main story's, else one with unread messages. */
export function defaultThread(threads: readonly SimThread[], chosen: string | undefined, preferredOperation: string = TOUR_OPERATION_NUMBER): SimThread | undefined {
  return (
    threads.find((thread) => thread.importerId === chosen) ??
    threads.find((thread) => thread.operations.some((operation) => operation.operationNumber === preferredOperation)) ??
    threads.find((thread) => thread.unread > 0) ??
    threads[0]
  );
}

/** Messages as the importer's phone shows them, oldest first. */
export function phoneMessages(thread: Pick<SimThread, "messages">): SimMessage[] {
  return thread.messages
    .filter((message) => message.direction === "IN" || !NOT_ON_PHONE.has(message.status))
    .sort((a, b) => Date.parse(a.sentAtSim) - Date.parse(b.sentAtSim) || a.messageId.localeCompare(b.messageId));
}

export interface DayGroup {
  readonly day: string;
  readonly messages: readonly SimMessage[];
}

/** Messages grouped by simulated day in Argentina ("jue 15/10"), like the day chips of WhatsApp. */
export function byDay(messages: readonly SimMessage[]): DayGroup[] {
  const groups: { day: string; messages: SimMessage[] }[] = [];
  for (const message of messages) {
    // "jue 15/10 22:00" without its hour.
    const day = formatSimDateTime(message.sentAtSim).slice(0, -6);
    const last = groups.at(-1);
    if (last && last.day === day) last.messages.push(message);
    else groups.push({ day, messages: [message] });
  }
  return groups;
}

export interface Ticks {
  readonly symbol: "✓" | "✓✓" | "!";
  readonly read: boolean;
  readonly label: string;
}

/** ✓ sent, ✓✓ delivered, ✓✓ read (highlighted), ! failed; nothing for an inbound message. */
export function ticksOf(message: Pick<SimMessage, "direction" | "status">): Ticks | undefined {
  if (message.direction !== "OUT") return undefined;
  const label = simulatorCopy.status[message.status];
  switch (message.status) {
    case "SENT":
      return { symbol: "✓", read: false, label: label ?? "" };
    case "DELIVERED":
      return { symbol: "✓✓", read: false, label: label ?? "" };
    case "READ":
      return { symbol: "✓✓", read: true, label: label ?? "" };
    case "FAILED":
      return { symbol: "!", read: false, label: label ?? "" };
    default:
      return undefined;
  }
}

/** "10:02": the hour of a bubble. */
export function bubbleTime(message: Pick<SimMessage, "sentAtSim">): string {
  return formatTime(message.sentAtSim);
}

/** The agent is writing: the BFF says so, or the world waits for a turn or event of one of the thread's operations. */
export function isTyping(thread: Pick<SimThread, "typing" | "operations">, pending: readonly WorldPending[]): boolean {
  if (thread.typing) return true;
  const numbers = new Set(thread.operations.map((operation) => operation.operationNumber));
  return pending.some((item) => (item.kind === "TURN" || item.kind === "EVENT") && item.operationNumber != null && numbers.has(item.operationNumber));
}

export type PdfProblem = "notPdf" | "tooLarge";

/** What the simulator checks before asking for an upload URL (the presigned POST checks it again). */
export function pdfProblem(file: Pick<File, "type" | "size" | "name">): PdfProblem | undefined {
  const isPdf = file.type === "application/pdf" || (file.type === "" && file.name.toLowerCase().endsWith(".pdf"));
  if (!isPdf) return "notPdf";
  if (file.size <= 0 || file.size > MAX_PDF_BYTES) return "tooLarge";
  return undefined;
}
