// The WhatsApp 24-hour window (`CP-WA-24H`, CONTEXT.md "Ventana de 24 h") and the notion of a reply
// that the rest of the policy shares (docs/design-brief.md §5.7):
//
//   - Only a WhatsApp message of the importer opens the window (a text, a button reply or an
//     attachment). Opening or using the upload link does not: an upload leaves no inbound message.
//   - The window is measured on the world's clock while WhatsApp is `simulated` and on real time when
//     it is `live`, because Meta measures real time.
//   - A send is a reply when it answers one message of the importer (named by `answers`, or the last
//     one when the send comes from a turn that message opened, or is a kind that only exists as an
//     answer) and goes out inside the window that message opened. A reply is exempt from
//     `CP-HOURS-AR` and is the only `REPLY` an approved dossier admits. The acknowledgement of an
//     upload is never one: its turn (`UPLOAD_COMPLETED`) was not opened by a message.
import { ARGENTINA_TIME_ZONE, toZonedIso } from "../services/business-hours";
import { deny, missing, pass, skip } from "./checks";
import type { PolicyContext, TimeBase } from "./context";
import { ANSWER_ONLY_KINDS, REPLY_TRIGGERS } from "./kinds";
import type { HistoryMessage, RuleCheck, WindowState } from "./types";

const WINDOW_MS = 24 * 3_600_000;

type WindowView = Omit<PolicyContext, "reply">;

function instantOf(entry: HistoryMessage, base: TimeBase): number {
  return Date.parse(base === "REAL" ? entry.sentAtReal : entry.sentAtSim);
}

function nowOf(view: WindowView): number {
  return (view.windowBase === "REAL" ? view.realNow : view.simNow).getTime();
}

function formatInstant(ms: number, base: TimeBase): string {
  return base === "REAL" ? new Date(ms).toISOString() : toZonedIso(new Date(ms), ARGENTINA_TIME_ZONE);
}

/** WhatsApp messages of the operation's importer received at or before the instant, oldest first. */
function importerInbound(view: WindowView): HistoryMessage[] {
  const now = nowOf(view);
  const base = view.windowBase;
  return (view.history ?? [])
    .filter(
      (entry) =>
        entry.direction === "IN" &&
        entry.channel === "WHATSAPP" &&
        entry.counterpart === "IMPORTER" &&
        (entry.importerId === undefined || entry.importerId === view.operation.importerId) &&
        instantOf(entry, base) <= now,
    )
    .sort((a, b) => instantOf(a, base) - instantOf(b, base));
}

/** The window at the instant: open while less than 24 hours passed since the importer's last message. */
export function windowAt(view: WindowView): WindowState {
  const last = importerInbound(view).at(-1);
  if (last === undefined) return { state: "CLOSED" };
  const openedAt = instantOf(last, view.windowBase);
  const closesAt = openedAt + WINDOW_MS;
  return { state: nowOf(view) < closesAt ? "OPEN" : "CLOSED", lastInboundAt: formatInstant(openedAt, view.windowBase), closesAt: formatInstant(closesAt, view.windowBase) };
}

function answersTheImporter(view: WindowView): boolean {
  const { answers, trigger, kind } = view.message;
  return answers !== undefined || (trigger !== undefined && REPLY_TRIGGERS.includes(trigger)) || (kind !== undefined && ANSWER_ONLY_KINDS.includes(kind));
}

/** Whether the send is a reply; `undefined` when it claims to answer but there is no history to check. */
export function replyOf(view: WindowView): boolean | undefined {
  if (!view.toImporterByWhatsApp || !answersTheImporter(view)) return false;
  if (view.history === undefined) return undefined;
  const inbound = importerInbound(view);
  const { answers } = view.message;
  const answered = answers === undefined ? inbound.at(-1) : inbound.find((entry) => entry.messageId === answers);
  return answered !== undefined && nowOf(view) - instantOf(answered, view.windowBase) < WINDOW_MS;
}

/** `CP-WA-24H`: outside the window only an approved template goes out (the tool answers `TEMPLATE_REQUIRED`). */
export function checkWindow(ctx: PolicyContext): RuleCheck {
  if (!ctx.toImporterByWhatsApp) return skip("the 24-hour window only applies to WhatsApp to the importer");
  const { template } = ctx.message;
  if (template !== undefined) return pass(`approved template ${template.name}: allowed inside and outside the window`);
  if (ctx.history === undefined) return missing(ctx, "the importer's message history");
  const window = windowAt(ctx);
  if (window.state === "OPEN") return pass(`free text inside the 24-hour window, open until ${window.closesAt ?? "?"}`);
  const since = window.lastInboundAt === undefined ? "the importer never wrote" : `the importer last wrote at ${window.lastInboundAt}`;
  return deny(`free text outside the 24-hour window (${since}): only an approved template may go out`);
}
