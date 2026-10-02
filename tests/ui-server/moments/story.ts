// The story of operation 4471 as rows of the guest's world (docs/landing-spec.md §1.4 and §7.2.1), one
// step per moment of the guided tour, each applied on top of the previous ones. While the turns of the
// agent do not run on the stage (wave 3, stage B), these rows stand in for what the scripted agent of
// the local flows would leave: the texts are the product's (packages/bff/src/copy, and the landing's
// story for what the model writes, labelled there as samples), the readings are the seed's ground
// truth, and the shapes are those the guest template uses for the same events in its other
// operations. Captures taken over them say "Entorno local, agente guionado".
import { importerEsAR, missingDocumentsEsAR } from "@legajo/bff/copy/es-AR";
import { firmEsAR } from "@legajo/bff/copy/es-AR-firm";
import { maskEmail } from "@legajo/shared";
import { CORRECTION_TARGET, STORY, SUPPLIER_THREAD, conversation } from "../../../packages/web/src/views/landing/conversations";
import type { MomentId } from "./ids";
import { FIRM_MAILBOX, GUEST_BROKER, SUPPLIER_CONTACT, type Tables, add, ar, decision, dispatchText, emailIn, emailOut, is4471, patch, readVersion, utc, whatsappIn, whatsappOut } from "./rows";


export interface MomentStep {
  readonly id: MomentId;
  /** Where the world's clock is paused at this moment. */
  readonly simNow: string;
  apply(tables: Tables): void;
}

function thread(id: (typeof SUPPLIER_THREAD)[number]["id"]): (typeof SUPPLIER_THREAD)[number] {
  const email = SUPPLIER_THREAD.find((candidate) => candidate.id === id);
  if (!email) throw new Error(`the landing's story has no ${id} email`);
  return email;
}
const agentText = (id: Parameters<typeof conversation>[0], index: number) => conversation(id).messages[index]?.text ?? "";

/** Carried between steps: the RFC ids of the thread and the importer-facing message ids. */
const memo = new Map<string, string>();

function fireMilestone(tables: Tables, timerId: string, at: string): void {
  patch(tables, "Operations", is4471("Timer", { timerId }), () => ({ status: "FIRED", firedBy: "CLOCK", firedAtSim: utc(at) }));
}

export const STORY_STEPS: readonly MomentStep[] = [
  { id: "start", simNow: ar("14/10", "10:30"), apply: () => undefined },
  {
    id: "after-request",
    simNow: ar("15/10", "10:01"),
    apply(tables) {
      const at = ar("15/10", "10:00");
      fireMilestone(tables, "DOCS_REQUEST", at);
      whatsappOut(tables, { at, kind: "DOCS_REQUEST", template: { name: "legajo_docs_pendientes", params: [STORY.firmName, STORY.operationNumber, STORY.vessel, STORY.etaText, missingDocumentsEsAR(STORY.missing)] }, extraRules: ["CP-HOURS-AR", "CP-ONE-PER-DAY"] });
      decision(tables, at, { action: "SEND_WHATSAPP", decision: "ALLOW", trigger: "MILESTONE", ruleIds: ["CP-OPTIN", "CP-HOURS-AR", "CP-ONE-PER-DAY"], detail: { kind: "DOCS_REQUEST" } });
    },
  },
  {
    id: "after-delegate",
    simNow: ar("15/10", "10:05"),
    apply(tables) {
      whatsappIn(tables, ar("15/10", "10:02"), conversation("delegate").messages[0]?.text ?? "", "SUPPLIER_SENDS");
      const masked = maskEmail(SUPPLIER_CONTACT.email);
      whatsappOut(tables, {
        at: ar("15/10", "10:02"),
        kind: "CONTACT_CONFIRMATION",
        body: importerEsAR.contactConfirmation({ maskedEmail: masked }),
        buttons: (conversation("delegate").messages[1]?.buttons ?? []).map((button, index) => ({ action: ["CONFIRM_CONTACT", "REJECT_CONTACT", "OTHER_CONTACT"][index] ?? "CONFIRM_CONTACT", title: button.text })),
        interactive: { actions: ["CONFIRM_CONTACT", "REJECT_CONTACT", "OTHER_CONTACT"], type: "button" },
      });
      whatsappIn(tables, ar("15/10", "10:03"), conversation("delegate").messages[2]?.text ?? "", "CONFIRM_CONTACT");
      decision(tables, ar("15/10", "10:03"), { action: "CONTACT_CONFIRMED", decision: "ACTION", refs: { contactId: SUPPLIER_CONTACT.contactId } });
      const deferredUntil = ar("15/10", "22:00");
      decision(tables, ar("15/10", "10:03"), { action: "SEND_EMAIL", decision: "DEFER", trigger: "CONTACT_CONFIRMED", ruleIds: ["CP-HOURS-SUPPLIER"], detail: { kind: "DOCS_REQUEST", nextAllowedAt: deferredUntil } });
      add(tables, "Operations", "Timer", { kind: "DEFERRED_SEND", timerId: "deferred-4471-1", dueAtSim: utc(deferredUntil), status: "SCHEDULED", reason: "CP-HOURS-SUPPLIER", payload: { kind: "DOCS_REQUEST" } });
      whatsappOut(tables, { at: ar("15/10", "10:04"), kind: "REPLY", body: agentText("delegate", 3) });
      decision(tables, ar("15/10", "10:04"), { action: "SEND_WHATSAPP", decision: "ALLOW", trigger: "CONTACT_CONFIRMED", detail: { kind: "REPLY" } });
    },
  },
  {
    id: "after-supplier-email",
    simNow: ar("15/10", "22:10"),
    apply(tables) {
      const request = thread("request");
      patch(tables, "Operations", is4471("Timer", { timerId: "deferred-4471-1" }), () => ({ status: "FIRED", firedBy: "CLOCK", firedAtSim: utc(ar("15/10", "22:00")) }));
      memo.set("request", emailOut(tables, ar("15/10", "22:00"), "DOCS_REQUEST", request.subject, request.body));
      decision(tables, ar("15/10", "22:00"), { action: "SEND_EMAIL", decision: "ALLOW", trigger: "DEFERRED_SEND", ruleIds: ["CP-SUPPLIER-AUTH", "CP-HOURS-SUPPLIER"], detail: { kind: "DOCS_REQUEST" } });
      const reply = thread("reply");
      memo.set("reply", emailIn(tables, ar("15/10", "22:10"), reply.subject, reply.body, memo.get("request") ?? "", [{ docVersionId: "dv-4471-PL-1", sizeBytes: 2048 }, { docVersionId: "dv-4471-CO-1", sizeBytes: 2048 }]));
    },
  },
  {
    id: "after-reading",
    simNow: ar("15/10", "22:12"),
    apply(tables) {
      const received = ar("15/10", "22:10");
      const read = ar("15/10", "22:11");
      const source = memo.get("reply") ?? "";
      const packingList = readVersion(tables, "PACKING_LIST", "PL", 1, received, read, source);
      const certificate = readVersion(tables, "CERTIFICATE_OF_ORIGIN", "CO", 1, received, read, source);
      patch(tables, "Operations", is4471("Document", { docType: "PACKING_LIST" }), () => ({ status: "WITH_OBSERVATION", currentVersion: 1, currentDocVersionId: packingList, receivedAtSim: received, responsibleParty: "SUPPLIER" }));
      patch(tables, "Operations", is4471("Document", { docType: "CERTIFICATE_OF_ORIGIN" }), () => ({ status: "VALID", currentVersion: 1, currentDocVersionId: certificate, receivedAtSim: received, validatedBy: "READER" }));
      add(tables, "Operations", "Observation", {
        observationId: "obs-4471-PL-GROSS_WEIGHT_MISMATCH",
        docType: "PACKING_LIST",
        againstDocType: "COMMERCIAL_INVOICE",
        code: "GROSS_WEIGHT_MISMATCH",
        field: "grossWeightKg",
        found: "12,480 kg",
        expected: "12,840 kg",
        severity: "BLOCKING",
        attempts: 0,
        firstDocVersionId: packingList,
        lastDocVersionId: packingList,
        flaggedForReview: false,
        matchesMatrix: true,
        matrixDefault: "SUPPLIER",
        responsibleParty: "SUPPLIER",
        status: "OPEN",
        history: [{ atSim: read, by: "SYSTEM", docVersionId: packingList, status: "OPEN" }],
      });
      decision(tables, read, { action: "RESPONSIBLE_ASSIGNED", decision: "ACTION", ruleIds: ["RESP-MATRIX"], refs: { observationId: "obs-4471-PL-GROSS_WEIGHT_MISMATCH" } });
    },
  },
  {
    id: "after-correction",
    simNow: ar("16/10", "09:05"),
    apply(tables) {
      const correction = thread("correction");
      const requested = ar("15/10", "22:12");
      memo.set("correction", emailOut(tables, requested, "CORRECTION_REQUEST", correction.subject, correction.body, memo.get("request")));
      decision(tables, requested, { action: "SEND_EMAIL", decision: "ALLOW", trigger: "READING", ruleIds: ["CP-SUPPLIER-AUTH", "CP-HOURS-SUPPLIER"], detail: { kind: "CORRECTION_REQUEST" } });
      decision(tables, requested, { action: "SEND_WHATSAPP", decision: "DEFER", trigger: "READING", ruleIds: ["CP-HOURS-AR"], detail: { kind: "NO_ACTION_NEEDED", nextAllowedAt: ar("16/10", "09:00") } });
      add(tables, "Operations", "Timer", { kind: "DEFERRED_SEND", timerId: "deferred-4471-2", dueAtSim: utc(ar("16/10", "09:00")), status: "FIRED", firedBy: "CLOCK", firedAtSim: utc(ar("16/10", "09:00")), reason: "CP-HOURS-AR", payload: { kind: "NO_ACTION_NEEDED" } });
      const corrected = thread("corrected");
      const arrived = ar("15/10", "22:20");
      const source = emailIn(tables, arrived, corrected.subject, corrected.body, memo.get("correction") ?? "", [{ docVersionId: "dv-4471-PL-2", sizeBytes: 2048 }]);
      const version2 = readVersion(tables, "PACKING_LIST", "PL", 2, arrived, ar("15/10", "22:21"), source);
      patch(tables, "Operations", is4471("Document", { docType: "PACKING_LIST" }), () => ({ status: "VALID", currentVersion: 2, currentDocVersionId: version2, receivedAtSim: arrived, validatedBy: "READER" }));
      patch(tables, "Operations", is4471("Observation"), (item) => ({
        status: "RESOLVED",
        attempts: 1,
        lastDocVersionId: version2,
        history: [...(item.history as unknown[]), { atSim: requested, by: "AGENT", docVersionId: "dv-4471-PL-1", status: "CORRECTION_REQUESTED" }, { atSim: ar("15/10", "22:21"), by: "SYSTEM", docVersionId: version2, status: "RESOLVED" }],
      }));
      patch(tables, "Operations", is4471("Operation"), (item) => ({ dossierStatus: "READY_FOR_REVIEW", dossierHistory: [...(item.dossierHistory as unknown[]), { atSim: ar("15/10", "22:21"), by: "AGENT", status: "READY_FOR_REVIEW" }] }));
      decision(tables, ar("15/10", "22:21"), { action: "READY_FOR_REVIEW", decision: "ACTION" });
      whatsappOut(tables, { at: ar("16/10", "09:00"), kind: "NO_ACTION_NEEDED", template: { name: "legajo_observacion_proveedor", params: [STORY.operationNumber, CORRECTION_TARGET] }, extraRules: ["CP-HOURS-AR"] });
      whatsappOut(tables, { at: ar("16/10", "09:00"), kind: "REPLY", body: agentText("noAction", 1) });
    },
  },
  {
    id: "after-eta-move",
    simNow: ar("16/10", "10:05"),
    apply(tables) {
      const at = ar("16/10", "10:00");
      const eta = ar("20/10", "08:00");
      patch(tables, "Operations", is4471("Operation"), (item) => ({ eta, etaHistory: [...(item.etaHistory as unknown[]), { eta, previousEta: item.eta, atSim: at, source: "CARRIER", eventId: "evt_carrier_4471_eta_1" }] }));
      const moved: Readonly<Record<string, string>> = { FOLLOWUP_FINAL: ar("17/10", "10:00"), ESCALATION: ar("18/10", "08:00"), ARRIVAL: ar("20/10", "08:00") };
      for (const [timerId, due] of Object.entries(moved)) patch(tables, "Operations", is4471("Timer", { timerId }), () => ({ dueAtSim: utc(due) }));
      patch(tables, "Operations", is4471("Timer", { timerId: "FOLLOWUP" }), () => ({ status: "SKIPPED", firedBy: "ETA_CHANGE", reason: "DOSSIER_COMPLETE" }));
      decision(tables, at, { action: "ETA_RESCHEDULED", decision: "ACTION", actor: "SYSTEM", detail: { previousEta: ar("22/10", "08:00"), eta } });
      whatsappOut(tables, { at: ar("16/10", "10:01"), kind: "ETA_CHANGE", template: { name: "legajo_nuevo_plazo", params: [STORY.operationNumber, STORY.newEtaText, STORY.newDeadlineText] } });
      decision(tables, ar("16/10", "10:01"), { action: "SEND_WHATSAPP", decision: "ALLOW", trigger: "ETA_CHANGE", ruleIds: ["CP-OPTIN", "CP-HOURS-AR"], detail: { kind: "ETA_CHANGE" } });
    },
  },
  {
    id: "after-escalation",
    simNow: ar("16/10", "10:30"),
    apply(tables) {
      const asked = ar("16/10", "10:24");
      whatsappIn(tables, asked, conversation("question").messages[0]?.text ?? "");
      whatsappOut(tables, { at: asked, kind: "REPLY", author: "SYSTEM", body: importerEsAR.guardrailRefusal });
      decision(tables, asked, { action: "GUARDRAIL_BLOCK", decision: "ACTION", actor: "SYSTEM", detail: { policy: "topicPolicy", origin: "PREFILTER", source: "IMPORTER" } });
      const summary = "Consulta de clasificación arancelaria: asesoramiento aduanero que responde el estudio.";
      add(tables, "Operations", "Escalation", { escalationId: "esc-4471-1", firmId: "firm-guest-00", reason: "OUT_OF_CHECKLIST", summary, status: "OPEN", openedAtSim: asked, openedBy: "SYSTEM", emailSent: true, notifyImporter: true });
      decision(tables, asked, { action: "ESCALATED", decision: "ACTION", actor: "SYSTEM", reason: "OUT_OF_CHECKLIST", refs: { escalationId: "esc-4471-1" } });
      whatsappOut(tables, { at: ar("16/10", "10:25"), kind: "ESCALATION_NOTICE", template: { name: "legajo_escalado", params: [STORY.operationNumber, STORY.firmName] } });
      const email = firmEsAR.escalationEmail({
        operationNumber: STORY.operationNumber,
        importerName: STORY.importerName,
        supplierName: STORY.supplierName,
        reason: "OUT_OF_CHECKLIST",
        summary,
        dossierStatus: "READY_FOR_REVIEW",
        etaText: "20/10 08:00",
        documents: [
          { docType: "COMMERCIAL_INVOICE", status: "VALID" },
          { docType: "PACKING_LIST", status: "VALID" },
          { docType: "CERTIFICATE_OF_ORIGIN", status: "VALID" },
        ],
        attempts: [{ atText: "16/10 10:24", channel: "WHATSAPP", recipient: "IMPORTER", kind: "REPLY" }],
        consoleUrl: "https://legajo.demo.craftech.io/app/operations/op-4471",
      });
      add(tables, "Conversations", "MailboxMessage", { mailboxAddress: FIRM_MAILBOX, mailboxMessageId: "mbx-esc-4471-1", from: "Legajo listo <avisos@legajo.demo.craftech.io>", to: FIRM_MAILBOX, subject: email.subject, bodyText: email.body, receivedAtReal: "2026-09-25T12:00:00.000Z", receivedAtSim: utc(ar("16/10", "10:25")) });
    },
  },
  {
    id: "after-approval",
    simNow: ar("16/10", "11:05"),
    apply(tables) {
      const resolved = ar("16/10", "10:50");
      patch(tables, "Operations", is4471("Escalation"), () => ({ status: "RESOLVED", resolvedAtSim: resolved, resolvedBy: GUEST_BROKER, resolution: "El estudio le respondió al importador desde la consola." }));
      decision(tables, resolved, { action: "ESCALATION_RESOLVED", decision: "ACTION", actor: GUEST_BROKER, refs: { escalationId: "esc-4471-1" } });
      const approved = ar("16/10", "11:00");
      patch(tables, "Operations", is4471("Operation"), (item) => ({ dossierStatus: "APPROVED", dossierHistory: [...(item.dossierHistory as unknown[]), { atSim: approved, by: GUEST_BROKER, status: "APPROVED" }] }));
      decision(tables, approved, { action: "DOSSIER_APPROVED", decision: "ACTION", actor: GUEST_BROKER, refs: { brokerId: "brk-guest-00" } });
      whatsappOut(tables, { at: approved, kind: "APPROVAL_NOTICE", author: GUEST_BROKER, template: { name: "legajo_aprobado", params: [STORY.operationNumber] } });
      decision(tables, approved, { action: "SEND_WHATSAPP", decision: "ALLOW", trigger: "APPROVAL", ruleIds: ["CP-APPROVED-SCOPE"], detail: { kind: "APPROVAL_NOTICE" } });
    },
  },
  {
    id: "after-dispatch",
    simNow: ar("16/10", "11:30"),
    apply(tables) {
      const channel = ar("16/10", "11:10");
      const released = ar("16/10", "11:20");
      patch(tables, "Operations", is4471("Operation"), () => ({
        dispatch: {
          status: "LIBERADO",
          occurredAtSim: released,
          history: [
            { status: "CANAL_ASIGNADO", channel: "NARANJA", occurredAtSim: channel, eventId: "evt_customs_4471_1" },
            { status: "LIBERADO", occurredAtSim: released, eventId: "evt_customs_4471_2" },
          ],
        },
      }));
      for (const [at, key] of [[channel, "CANAL_ASIGNADO#NARANJA"], [released, "LIBERADO"]] as const) {
        whatsappOut(tables, { at, kind: "DISPATCH_STATUS", template: { name: "despacho_estado", params: [STORY.operationNumber, ...dispatchText(key)] } });
        decision(tables, at, { action: "SEND_WHATSAPP", decision: "ALLOW", trigger: "DISPATCH_STATUS", ruleIds: ["CP-APPROVED-SCOPE"], detail: { kind: "DISPATCH_STATUS" } });
      }
    },
  },
];

/** Starts a build of the story from scratch (thread ids carried between steps). */
export function resetStory(): void {
  memo.clear();
}
