// The seeded past of the operations that start the demo with a history (docs/seed-spec.md §3 and §7):
// op-4478 (holiday deferral, delegation to the supplier, reminder), op-4487 (approved), op-4488
// (ready for review after a corrected packing list), op-4489 (approved and released) and Norte's
// op-5505. Every message carries the instant the policy lets it out (invariant 10); the same stories
// run for the clones of the `guest` and `qa-min` templates, with that world's parties.
import type { CustomsChannel, DispatchStatus, DocType, MilestoneName, TimerStatus } from "@legajo/shared";
import { DISPATCH_GLOSSARY, dispatchGlossaryKey } from "@legajo/bff/copy/dispatch-glossary";
import { importerEsAR, missingDocumentsEsAR } from "@legajo/bff/copy/es-AR";
import { supplierEmailEn } from "@legajo/bff/copy/en";
import { BUTTON_LABELS } from "@legajo/bff/copy/buttons";
import { docVersionId, maskEmail } from "@legajo/shared";
import { seedHistoryEventId } from "../lib/seed-keys";
import { templateItem, type SeedItem } from "../lib/items";
import { ESCALATION_NO_AUTH_RESOLUTION, ESCALATION_NO_AUTH_SUMMARY, IMPORTER_CORRECTED_TEXT, IMPORTER_PDF_TEXTS, packagesDifferenceReply, readyForReviewReply, supplierAskedReply, supplierDocsRequest, supplierReminder } from "./history-texts";
import { allowed, decision, emailOut, messageIdAt, stopped, uploadToken, whatsAppIn, whatsAppTemplateOut, whatsAppTextOut, type StoryScope } from "./timeline";
import { MILESTONES, arAt, arDate, dayMonth, enDate, enDateTime, milestoneTimes, plusDays, plusMinutes, utc, zonedAt } from "./time";

export interface VersionSource {
  readonly party: "IMPORTER" | "SUPPLIER" | "BROKER";
  readonly channel: "EMAIL" | "WHATSAPP" | "UPLOAD_LINK" | "CONSOLE";
  readonly messageId?: string;
  readonly uploadToken?: string;
  readonly contactId?: string;
}

export interface DocHistory {
  readonly versions: readonly { readonly versionNo: number; readonly receivedAtSim: string; readonly source: VersionSource }[];
  readonly requestedFrom?: "IMPORTER" | "SUPPLIER";
  readonly lastRequestedAtSim?: string;
  readonly responsibleParty?: "IMPORTER" | "SUPPLIER";
}

export interface MilestoneState {
  readonly status: TimerStatus;
  readonly firedAtSim?: string;
  readonly reason?: string;
}

export interface Story {
  readonly messages: SeedItem[];
  readonly decisions: SeedItem[];
  readonly timers: SeedItem[];
  readonly escalations: SeedItem[];
  readonly milestones: Partial<Record<MilestoneName, MilestoneState>>;
  readonly dossier: readonly { readonly atSim: string; readonly by: string; readonly status: "READY_FOR_REVIEW" | "APPROVED" }[];
  readonly approved?: { readonly by: string; readonly atSim: string };
  readonly docs: Partial<Record<DocType, DocHistory>>;
  /** Status history of the seeded observation after it opened (v1 read). */
  readonly observation?: { readonly events: readonly { readonly atSim: string; readonly by: string; readonly status: "RESOLVED" | "CORRECTION_REQUESTED" }[]; readonly responsibleParty: "SUPPLIER"; readonly escalationId?: string };
  readonly dispatch?: { readonly status: DispatchStatus; readonly channel?: CustomsChannel; readonly occurredAtSim: string; readonly history: readonly Record<string, string>[] };
  /** The importer confirmed the registered contact (FL-011/FL-012). */
  readonly contactConfirmedAt?: string;
}

export interface PdfSize {
  size(modelNumber: string, docType: DocType, versionNo: number): number;
}

const ALL: readonly DocType[] = ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"];
const DOCS_MISSING_AFTER_CI: readonly DocType[] = ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"];
const ROME_OFFSET_MINUTES = 120;

function empty(): Story {
  return { messages: [], decisions: [], timers: [], escalations: [], milestones: {}, dossier: [], docs: {} };
}

const agent = "AGENT";
const broker = (id: string) => `BROKER:${id}`;

/** Milestones of a dossier that completed before them: `fired` went off while it was open, the rest skip. */
function skippedAfterCompletion(eta: string, fired: readonly MilestoneName[]): Partial<Record<MilestoneName, MilestoneState>> {
  const times = milestoneTimes(eta);
  const out: Partial<Record<MilestoneName, MilestoneState>> = {};
  for (const name of MILESTONES) out[name] = fired.includes(name) ? { status: "FIRED", firedAtSim: times[name] } : { status: "SKIPPED", reason: "DOSSIER_COMPLETE" };
  return out;
}

/** The DOCS_REQUEST template of a milestone, deferred by CP-HOURS-AR to `sentAt` when `deferredFrom` is given. */
function docsRequestTemplate(scope: StoryScope, story: Story, sentAt: string, missing: readonly DocType[], deferredFrom?: string): string {
  const { op, world } = scope;
  const flags = { route: "WHATSAPP" as const, kind: "DOCS_REQUEST" as const, author: agent, reply: false, template: true };
  const messageId = messageIdAt(scope, sentAt);
  const token = uploadToken(scope);
  let timerKey: string | undefined;
  if (deferredFrom !== undefined) {
    const timerId = `deferred-${op.number}-1`;
    timerKey = `TIMER#DEFERRED_SEND#${timerId}`;
    story.decisions.push(decision(scope, { atSim: deferredFrom, decision: "DEFER", action: "SEND_WHATSAPP", actor: agent, trigger: "MILESTONE", evaluation: stopped(flags, "CP-HOURS-AR", "DEFER", `outside Buenos Aires business hours: deferred to ${sentAt}`), refs: { timerKey }, detail: { nextAllowedAt: sentAt, kind: "DOCS_REQUEST" } }));
    story.timers.push(templateItem("Timer", { operationId: op.operationId, clockId: world.clockId, kind: "DEFERRED_SEND", timerId, dueAtSim: utc(sentAt), status: "FIRED", firedBy: "CLOCK", firedAtSim: sentAt, reason: "CP-HOURS-AR", payload: { messageId, kind: "DOCS_REQUEST" } }));
  }
  const params = [world.firm.name, op.number, op.model.vessel, dayMonth(op.model.eta), missingDocumentsEsAR(missing)];
  const evaluation = allowed(flags);
  story.messages.push(whatsAppTemplateOut(scope, { messageId, atSim: sentAt, kind: "DOCS_REQUEST", author: agent, evaluation, docTypes: missing, ...(timerKey === undefined ? {} : { deferredTimerKey: timerKey }) }, "legajo_docs_pendientes", params, token));
  story.decisions.push(decision(scope, { atSim: sentAt, decision: "ALLOW", action: "SEND_WHATSAPP", actor: deferredFrom === undefined ? agent : "SYSTEM", trigger: "MILESTONE", evaluation, messageId, detail: { kind: "DOCS_REQUEST" } }));
  return token;
}

function templateNotice(scope: StoryScope, story: Story, sentAt: string, author: string, name: "legajo_aprobado" | "despacho_estado", params: readonly string[], trigger: string): void {
  const messageId = messageIdAt(scope, sentAt);
  const kind = name === "legajo_aprobado" ? "APPROVAL_NOTICE" : "DISPATCH_STATUS";
  const evaluation = allowed({ route: "WHATSAPP", kind, author, reply: false, template: true });
  story.messages.push(whatsAppTemplateOut(scope, { messageId, atSim: sentAt, kind, author, evaluation }, name, params));
  story.decisions.push(decision(scope, { atSim: sentAt, decision: "ALLOW", action: "SEND_WHATSAPP", actor: author, trigger, evaluation, messageId, detail: { kind } }));
}

/** The three documents the importer uploaded with the link of the request sent at `requestedAt`. */
function uploads(token: string, from: string, requestedAt: string): DocHistory[] {
  return ALL.map((_, index) => ({ versions: [{ versionNo: 1, receivedAtSim: plusMinutes(from, index), source: { party: "IMPORTER", channel: "UPLOAD_LINK", uploadToken: token } }], requestedFrom: "IMPORTER", lastRequestedAtSim: requestedAt }));
}

function approve(scope: StoryScope, story: Story, readyAt: string, approvedAt: string): Story {
  const approver = broker(scope.world.approverId);
  story.decisions.push(decision(scope, { atSim: readyAt, decision: "ACTION", action: "READY_FOR_REVIEW", actor: agent }));
  story.decisions.push(decision(scope, { atSim: approvedAt, decision: "ACTION", action: "DOSSIER_APPROVED", actor: approver, refs: { brokerId: scope.world.approverId } }));
  templateNotice(scope, story, approvedAt, approver, "legajo_aprobado", [scope.op.number], "APPROVAL");
  return { ...story, dossier: [{ atSim: readyAt, by: agent, status: "READY_FOR_REVIEW" }, { atSim: approvedAt, by: approver, status: "APPROVED" }], approved: { by: scope.world.approverId, atSim: approvedAt } };
}

/** op-4478: holiday deferral, delegation to the supplier (NEVER), reminder of the FOLLOWUP milestone. */
function story4478(scope: StoryScope): Story {
  const { op, world } = scope;
  const story = empty();
  const times = milestoneTimes(op.model.eta);
  docsRequestTemplate(scope, story, arAt("2026-10-13", "09:00"), DOCS_MISSING_AFTER_CI, times.DOCS_REQUEST);
  const buttonAt = arAt("2026-10-13", "09:05");
  const buttonId = messageIdAt(scope, buttonAt);
  story.messages.push(whatsAppIn(scope, { messageId: buttonId, atSim: buttonAt, author: "IMPORTER" }, BUTTON_LABELS.SUPPLIER_SENDS.template, { button: "SUPPLIER_SENDS" }));
  const askAt = arAt("2026-10-13", "09:06");
  const askId = messageIdAt(scope, askAt);
  const askEvaluation = allowed({ route: "WHATSAPP", kind: "CONTACT_CONFIRMATION", author: agent, reply: true, template: false });
  story.messages.push(whatsAppTextOut(scope, { messageId: askId, atSim: askAt, kind: "CONTACT_CONFIRMATION", author: agent, evaluation: askEvaluation }, importerEsAR.contactConfirmation({ maskedEmail: maskEmail(op.supplier.contactEmail) }), ["CONFIRM_CONTACT", "REJECT_CONTACT", "OTHER_CONTACT"]));
  story.decisions.push(decision(scope, { atSim: askAt, decision: "ALLOW", action: "SEND_WHATSAPP", actor: agent, trigger: "IMPORTER_MESSAGE", evaluation: askEvaluation, messageId: askId, detail: { kind: "CONTACT_CONFIRMATION", answers: buttonId } }));
  const confirmAt = arAt("2026-10-13", "09:15");
  const confirmId = messageIdAt(scope, confirmAt);
  story.messages.push(whatsAppIn(scope, { messageId: confirmId, atSim: confirmAt, author: "IMPORTER" }, BUTTON_LABELS.CONFIRM_CONTACT.interactive, { button: "CONFIRM_CONTACT" }));
  story.decisions.push(decision(scope, { atSim: confirmAt, decision: "ACTION", action: "CONTACT_CONFIRMED", actor: "IMPORTER", refs: { contactId: op.supplier.contactId } }));

  // Deadline: ETA − 4 days at 17:00 in the supplier's zone (Rome is on CEST, UTC+02:00, until 25/10).
  const deadline = enDateTime(zonedAt(arDate(plusDays(op.model.eta, -4)), "17:00", ROME_OFFSET_MINUTES), ROME_OFFSET_MINUTES);
  const facts = { firmName: world.firm.name, importerName: op.importer.spec.name, operationNumber: op.number, invoiceNumber: op.model.invoiceNumber, incoterm: `${op.model.incoterm} ${op.model.incotermPlace}`, vessel: op.model.vessel, etaText: enDate(op.model.eta, -180), deadlineText: deadline, docTypes: DOCS_MISSING_AFTER_CI };
  const subjectParams = { operationNumber: op.number, invoiceNumber: op.model.invoiceNumber, docTypes: DOCS_MISSING_AFTER_CI };
  const emailAt = arAt("2026-10-13", "09:20");
  const emailId = messageIdAt(scope, emailAt);
  const emailFlags = { route: "EMAIL" as const, kind: "DOCS_REQUEST" as const, author: agent, reply: false, template: false };
  const request = emailOut(scope, { messageId: emailId, atSim: emailAt, kind: "DOCS_REQUEST", author: agent, evaluation: allowed(emailFlags), docTypes: DOCS_MISSING_AFTER_CI }, supplierEmailEn.subject("DOCS_REQUEST", subjectParams), supplierDocsRequest(facts));
  story.messages.push(request);
  story.decisions.push(decision(scope, { atSim: emailAt, decision: "ALLOW", action: "SEND_EMAIL", actor: agent, trigger: "CONTACT_CONFIRMED", evaluation: allowed(emailFlags), messageId: emailId, refs: { contactId: op.supplier.contactId }, detail: { kind: "DOCS_REQUEST" } }));
  const replyAt = arAt("2026-10-13", "09:21");
  const replyId = messageIdAt(scope, replyAt);
  const replyEvaluation = allowed({ route: "WHATSAPP", kind: "REPLY", author: agent, reply: true, template: false });
  story.messages.push(whatsAppTextOut(scope, { messageId: replyId, atSim: replyAt, kind: "REPLY", author: agent, evaluation: replyEvaluation, docTypes: DOCS_MISSING_AFTER_CI }, supplierAskedReply(op.supplier.spec.name, op.number, DOCS_MISSING_AFTER_CI)));
  story.decisions.push(decision(scope, { atSim: replyAt, decision: "ALLOW", action: "SEND_WHATSAPP", actor: agent, trigger: "CONTACT_CONFIRMED", evaluation: replyEvaluation, messageId: replyId, detail: { kind: "REPLY", answers: confirmId } }));

  const reminderAt = times.FOLLOWUP;
  const reminderId = messageIdAt(scope, reminderAt);
  const reminderFlags = { route: "EMAIL" as const, kind: "REMINDER" as const, author: agent, reply: false, template: false };
  story.messages.push(emailOut(scope, { messageId: reminderId, atSim: reminderAt, kind: "REMINDER", author: agent, evaluation: allowed(reminderFlags), docTypes: DOCS_MISSING_AFTER_CI }, supplierEmailEn.subject("REMINDER", subjectParams), supplierReminder(facts), request));
  story.decisions.push(decision(scope, { atSim: reminderAt, decision: "ALLOW", action: "SEND_EMAIL", actor: agent, trigger: "MILESTONE", evaluation: allowed(reminderFlags), messageId: reminderId, refs: { contactId: op.supplier.contactId }, detail: { kind: "REMINDER" } }));

  const toSupplier: DocHistory = { versions: [], requestedFrom: "SUPPLIER", lastRequestedAtSim: reminderAt, responsibleParty: "SUPPLIER" };
  return {
    ...story,
    milestones: { DOCS_REQUEST: { status: "FIRED", firedAtSim: times.DOCS_REQUEST }, FOLLOWUP: { status: "FIRED", firedAtSim: times.FOLLOWUP } },
    docs: { PACKING_LIST: toSupplier, CERTIFICATE_OF_ORIGIN: toSupplier },
    contactConfirmedAt: confirmAt,
  };
}

/** op-4487: request on 09/10, upload by link, ready for review, approved on 13/10 (no dispatch yet). */
function story4487(scope: StoryScope): Story {
  const story = empty();
  const times = milestoneTimes(scope.op.model.eta);
  const token = docsRequestTemplate(scope, story, times.DOCS_REQUEST, ALL);
  const uploadAt = arAt("2026-10-09", "15:40");
  const [ci, pl, co] = uploads(token, uploadAt, times.DOCS_REQUEST);
  const readyAt = arAt("2026-10-09", "15:45");
  const approved = approve(scope, story, readyAt, arAt("2026-10-13", "11:00"));
  return { ...approved, milestones: skippedAfterCompletion(scope.op.model.eta, ["DOCS_REQUEST"]), docs: { COMMERCIAL_INVOICE: ci, PACKING_LIST: pl, CERTIFICATE_OF_ORIGIN: co } };
}

/** op-4488: the importer sends the three PDFs; the packing list differs; no authorization; corrected v2. */
function story4488(scope: StoryScope, pdfs: PdfSize): Story {
  const { op, world } = scope;
  const story = empty();
  const docs: Partial<Record<DocType, DocHistory>> = {};
  let lastInbound = "";
  ALL.forEach((docType, index) => {
    const receivedAt = arAt("2026-10-13", `11:0${index}`);
    const messageId = messageIdAt(scope, receivedAt);
    lastInbound = messageId;
    const attachment = { docVersionId: docVersionId(op.operationId, docType, 1), sizeBytes: pdfs.size(op.model.number, docType, 1) };
    story.messages.push(whatsAppIn(scope, { messageId, atSim: receivedAt, author: "IMPORTER" }, IMPORTER_PDF_TEXTS[docType], { attachment }));
    docs[docType] = { versions: [{ versionNo: 1, receivedAtSim: receivedAt, source: { party: "IMPORTER", channel: "WHATSAPP", messageId } }] };
  });
  const assignedAt = arAt("2026-10-13", "11:04");
  story.decisions.push(decision(scope, { atSim: assignedAt, decision: "ACTION", action: "RESPONSIBLE_ASSIGNED", actor: agent, refs: { observationId: `obs-${op.number}-PL-PACKAGES_MISMATCH` } }));
  const emailFlags = { route: "EMAIL" as const, kind: "CORRECTION_REQUEST" as const, author: agent, reply: false, template: false };
  story.decisions.push(decision(scope, { atSim: assignedAt, decision: "DENY", action: "SEND_EMAIL", actor: agent, trigger: "IMPORTER_MESSAGE", evaluation: stopped(emailFlags, "CP-SUPPLIER-AUTH", "DENY", "the importer has not authorized the agent to write to this supplier"), detail: { kind: "CORRECTION_REQUEST" } }));
  const escalationId = "esc-other-1";
  story.escalations.push(templateItem("Escalation", { escalationId, operationId: op.operationId, firmId: world.firm.firmId, clockId: world.clockId, reason: "OTHER", summary: ESCALATION_NO_AUTH_SUMMARY, status: "RESOLVED", openedAtSim: assignedAt, openedBy: agent, emailSent: false, notifyImporter: false, observationId: `obs-${op.number}-PL-PACKAGES_MISMATCH`, resolvedAtSim: arAt("2026-10-13", "12:30"), resolvedBy: broker(world.analystId), resolution: ESCALATION_NO_AUTH_RESOLUTION }));
  story.decisions.push(decision(scope, { atSim: assignedAt, decision: "ACTION", action: "ESCALATED", actor: agent, refs: { escalationId }, reason: "OTHER" }));
  const replyAt = arAt("2026-10-13", "11:05");
  const replyId = messageIdAt(scope, replyAt);
  const reply = allowed({ route: "WHATSAPP", kind: "REPLY", author: agent, reply: true, template: false });
  story.messages.push(whatsAppTextOut(scope, { messageId: replyId, atSim: replyAt, kind: "REPLY", author: agent, evaluation: reply }, packagesDifferenceReply(op.number)));
  story.decisions.push(decision(scope, { atSim: replyAt, decision: "ALLOW", action: "SEND_WHATSAPP", actor: agent, trigger: "IMPORTER_MESSAGE", evaluation: reply, messageId: replyId, detail: { kind: "REPLY", answers: lastInbound } }));
  story.decisions.push(decision(scope, { atSim: arAt("2026-10-13", "12:30"), decision: "ACTION", action: "ESCALATION_RESOLVED", actor: broker(world.analystId), refs: { escalationId, brokerId: world.analystId } }));

  const correctedAt = arAt("2026-10-13", "16:30");
  const correctedId = messageIdAt(scope, correctedAt);
  story.messages.push(whatsAppIn(scope, { messageId: correctedId, atSim: correctedAt, author: "IMPORTER" }, IMPORTER_CORRECTED_TEXT, { attachment: { docVersionId: docVersionId(op.operationId, "PACKING_LIST", 2), sizeBytes: pdfs.size(op.model.number, "PACKING_LIST", 2) } }));
  docs.PACKING_LIST = { versions: [...(docs.PACKING_LIST?.versions ?? []), { versionNo: 2, receivedAtSim: correctedAt, source: { party: "IMPORTER", channel: "WHATSAPP", messageId: correctedId } }], responsibleParty: "SUPPLIER" };
  const readyAt = arAt("2026-10-13", "16:32");
  story.decisions.push(decision(scope, { atSim: readyAt, decision: "ACTION", action: "READY_FOR_REVIEW", actor: agent }));
  const doneAt = arAt("2026-10-13", "16:33");
  const doneId = messageIdAt(scope, doneAt);
  story.messages.push(whatsAppTextOut(scope, { messageId: doneId, atSim: doneAt, kind: "REPLY", author: agent, evaluation: reply }, readyForReviewReply(op.number)));
  story.decisions.push(decision(scope, { atSim: doneAt, decision: "ALLOW", action: "SEND_WHATSAPP", actor: agent, trigger: "IMPORTER_MESSAGE", evaluation: reply, messageId: doneId, detail: { kind: "REPLY", answers: correctedId } }));
  return {
    ...story,
    milestones: skippedAfterCompletion(op.model.eta, []),
    dossier: [{ atSim: readyAt, by: agent, status: "READY_FOR_REVIEW" }],
    docs,
    observation: { events: [{ atSim: arAt("2026-10-13", "16:31"), by: "SYSTEM", status: "RESOLVED" }], responsibleParty: "SUPPLIER", escalationId },
  };
}

/** op-4489: request deferred from Saturday 03/10, upload, approval, dispatch statuses up to LIBERADO. */
function story4489(scope: StoryScope): Story {
  const { op } = scope;
  const story = empty();
  const times = milestoneTimes(op.model.eta);
  const requestedAt = arAt("2026-10-05", "09:00");
  const token = docsRequestTemplate(scope, story, requestedAt, ALL, times.DOCS_REQUEST);
  const [ci, pl, co] = uploads(token, arAt("2026-10-05", "09:40"), requestedAt);
  const approvedAt = arAt("2026-10-05", "09:55");
  const approved = approve(scope, story, arAt("2026-10-05", "09:45"), approvedAt);
  const events: { status: DispatchStatus; channel?: CustomsChannel; at: string }[] = [
    { status: "OFICIALIZADO", at: arAt("2026-10-09", "10:00") },
    { status: "CANAL_ASIGNADO", channel: "VERDE", at: arAt("2026-10-13", "10:00") },
    { status: "LIBERADO", at: arAt("2026-10-13", "15:00") },
  ];
  const history = events.map((event, index) => {
    const glossary = DISPATCH_GLOSSARY[dispatchGlossaryKey(event.status, event.channel) ?? "LIBERADO"];
    templateNotice(scope, story, event.at, "SYSTEM", "despacho_estado", [op.number, glossary.statusText, glossary.explanation], "DISPATCH_STATUS");
    return { status: event.status, ...(event.channel === undefined ? {} : { channel: event.channel }), occurredAtSim: event.at, eventId: seedHistoryEventId("DISPATCH_STATUS", op.operationId, index + 1) };
  });
  const cancelled: MilestoneState = { status: "CANCELLED", reason: "DOSSIER_APPROVED" };
  return {
    ...approved,
    milestones: { DOCS_REQUEST: { status: "FIRED", firedAtSim: times.DOCS_REQUEST }, FOLLOWUP: cancelled, FOLLOWUP_FINAL: cancelled, ESCALATION: cancelled, ARRIVAL: { status: "FIRED", firedAtSim: times.ARRIVAL } },
    docs: { COMMERCIAL_INVOICE: ci, PACKING_LIST: pl, CERTIFICATE_OF_ORIGIN: co },
    dispatch: { status: "LIBERADO", channel: "VERDE", occurredAtSim: arAt("2026-10-13", "15:00"), history },
  };
}

/** Norte's op-5505: the firm loaded the three documents itself; ready for review on 09/10. */
function story5505(scope: StoryScope): Story {
  const story = empty();
  const loadedAt = arAt("2026-10-09", "11:00");
  const byFirm: VersionSource = { party: "BROKER", channel: "CONSOLE" };
  const docs = Object.fromEntries(ALL.map((docType, index) => [docType, { versions: [{ versionNo: 1, receivedAtSim: plusMinutes(loadedAt, index), source: byFirm }] }])) as Partial<Record<DocType, DocHistory>>;
  const readyAt = arAt("2026-10-09", "11:05");
  story.decisions.push(decision(scope, { atSim: readyAt, decision: "ACTION", action: "READY_FOR_REVIEW", actor: "SYSTEM" }));
  return { ...story, milestones: skippedAfterCompletion(scope.op.model.eta, []), dossier: [{ atSim: readyAt, by: "SYSTEM", status: "READY_FOR_REVIEW" }], docs };
}

/** The history of an operation of `scope.world`, by its model; `undefined` for one that starts clean. */
export function storyOf(scope: StoryScope, pdfs: PdfSize): Story | undefined {
  switch (scope.op.model.number) {
    case "4478":
      return story4478(scope);
    case "4487":
      return story4487(scope);
    case "4488":
      return story4488(scope, pdfs);
    case "4489":
      return story4489(scope);
    case "5505":
      return story5505(scope);
    default:
      return undefined;
  }
}
