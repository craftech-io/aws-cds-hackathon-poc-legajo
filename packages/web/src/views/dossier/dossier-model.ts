// The dossier as the console shows it (docs/design-brief.md §6, row 2; FL-042..FL-044, FL-067,
// FL-068, FL-073, FL-075): per document its state, responsible, versions with their reading and the
// observations with their attempts; which actions the role and the state allow (approve and reopen
// only BROKER or GUEST, ADR-0010); when approving needs the password again (15 minutes of real time,
// the BFF's `recentLoginProcedure`); and how the firm may write to the importer (control taken, the
// 24-hour window of WhatsApp, the scope of an approved dossier). The BFF enforces every rule again.
import { CONSOLE_TEXT_MAX, type ConsoleRole, type ConversationControl, type DocStatus, type DocType, type DossierStatus, type Party, canApprove } from "@legajo/shared";
import { DOC_TYPE_ORDER } from "./labels";
import type { DocumentData, DossierData, MessageData, ObservationData, TimelineEntryData, VersionData } from "./types";

/** Observation statuses that still ask for something: the firm may waive them (FL-043). */
const OPEN_OBSERVATION_STATUSES: ReadonlySet<ObservationData["status"]> = new Set(["OPEN", "CORRECTION_REQUESTED", "ESCALATED"]);

export function isObservationOpen(observation: Pick<ObservationData, "status">): boolean {
  return OPEN_OBSERVATION_STATUSES.has(observation.status);
}

export interface DocumentCard {
  readonly docType: DocType;
  readonly status: DocStatus;
  readonly document: DocumentData | undefined;
  /** Newest first. */
  readonly versions: readonly VersionData[];
  /** Open ones first, blocking before warnings. */
  readonly observations: readonly ObservationData[];
  /** Versions the reader did not recognize and nobody classified yet (FL-044). */
  readonly unrecognized: readonly VersionData[];
}

function observationRank(observation: ObservationData): number {
  const open = isObservationOpen(observation) ? 0 : 2;
  return open + (observation.severity === "BLOCKING" ? 0 : 1);
}

/** The three documents in the dossier's order, each with its versions and observations. */
export function documentCards(dossier: Pick<DossierData, "documents" | "versions" | "observations">): DocumentCard[] {
  return DOC_TYPE_ORDER.map((docType) => {
    const document = dossier.documents.find((item) => item.docType === docType);
    const versions = dossier.versions.filter((version) => version.docType === docType).sort((a, b) => b.versionNo - a.versionNo);
    const observations = dossier.observations.filter((observation) => observation.docType === docType).sort((a, b) => observationRank(a) - observationRank(b));
    return {
      docType,
      status: document?.status ?? "MISSING",
      document,
      versions,
      observations,
      unrecognized: versions.filter((version) => version.state === "UNRECOGNIZED"),
    };
  });
}

/** An observation assigned against the firm's matrix, marked for the firm to review (FL-042). */
export function differsFromMatrix(observation: Pick<ObservationData, "flaggedForReview" | "responsibleParty" | "matrixDefault">): boolean {
  if (observation.flaggedForReview) return true;
  const { matrixDefault, responsibleParty } = observation;
  return matrixDefault !== undefined && matrixDefault !== "SENDER" && responsibleParty !== undefined && responsibleParty !== matrixDefault;
}

export interface Outstanding {
  readonly docType: DocType;
  readonly status: DocStatus;
  /** Who owes it: the party of an open observation, else the document's responsible. */
  readonly owedBy: Party | undefined;
}

/** What keeps the dossier from being complete, and who owes each piece. */
export function outstandingOf(dossier: Pick<DossierData, "documents" | "versions" | "observations">): Outstanding[] {
  return documentCards(dossier)
    .filter((card) => card.status !== "VALID")
    .map((card) => {
      const open = card.observations.find((observation) => isObservationOpen(observation) && observation.responsibleParty !== undefined);
      return { docType: card.docType, status: card.status, owedBy: open?.responsibleParty ?? card.document?.responsibleParty };
    });
}

// ---- Actions ------------------------------------------------------------------------------------

export type Gate = { readonly visible: false } | { readonly visible: true; readonly enabled: true } | { readonly visible: true; readonly enabled: false; readonly reason: "NOT_READY" };

/** "Aprobar legajo": only for BROKER or GUEST (an analyst never sees it, FL-075), open once ready for review. */
export function approveGate(role: ConsoleRole | undefined, status: DossierStatus): Gate {
  if (role === undefined || !canApprove(role) || status === "APPROVED") return { visible: false };
  return status === "READY_FOR_REVIEW" ? { visible: true, enabled: true } : { visible: true, enabled: false, reason: "NOT_READY" };
}

/** "Reabrir": only for BROKER or GUEST, only on an approved dossier. */
export function reopenGate(role: ConsoleRole | undefined, status: DossierStatus): Gate {
  if (role === undefined || !canApprove(role) || status !== "APPROVED") return { visible: false };
  return { visible: true, enabled: true };
}

/** Approving and reopening need an interactive sign-in at most this old (real time, ADR-0010). */
const RECENT_LOGIN_MS = 15 * 60_000;
/** The console asks for the password a minute early, so the call that follows is not refused on its way. */
const STEP_UP_MARGIN_MS = 60_000;

/** True when the password has to be confirmed before approving or reopening. */
export function needsStepUp(authTimeMs: number | undefined, nowMs: number): boolean {
  if (authTimeMs === undefined) return true;
  return nowMs - authTimeMs >= RECENT_LOGIN_MS - STEP_UP_MARGIN_MS;
}

// ---- Writing to the importer ---------------------------------------------------------------------

/** WhatsApp's customer-service window, measured on the world's clock while the channel is simulated. */
const WHATSAPP_WINDOW_MS = 24 * 60 * 60_000;

function isImporterWhatsApp(message: MessageData): boolean {
  return message.direction === "IN" && message.channel === "WHATSAPP" && message.counterpart === "IMPORTER";
}

/** When the importer last wrote by WhatsApp, if ever. */
function lastImporterMessageAt(entries: readonly TimelineEntryData[]): string | undefined {
  let last: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "MESSAGE" || !isImporterWhatsApp(entry.message)) continue;
    if (last === undefined || Date.parse(entry.message.sentAtSim) > Date.parse(last)) last = entry.message.sentAtSim;
  }
  return last;
}

/** Free text is allowed within 24 h of the importer's last message; outside it, only approved templates (CP-WA-24H). */
export function whatsappWindowOpen(entries: readonly TimelineEntryData[], simNow: string | undefined): boolean {
  const last = lastImporterMessageAt(entries);
  if (last === undefined || simNow === undefined) return false;
  const elapsed = Date.parse(simNow) - Date.parse(last);
  return elapsed >= 0 && elapsed < WHATSAPP_WINDOW_MS;
}

/**
 * What the firm may write to the importer: take the conversation first (the agent has it); nothing
 * but the approval and dispatch notices once the dossier is approved (CP-APPROVED-SCOPE); free text
 * inside the window; templates outside it.
 */
export type ComposerMode = "TAKE_FIRST" | "APPROVED_SCOPE" | "FREE_TEXT" | "TEMPLATE_ONLY";

export function composerMode(control: ConversationControl, status: DossierStatus, windowOpen: boolean): ComposerMode {
  if (control !== "BROKER") return "TAKE_FIRST";
  if (status === "APPROVED") return "APPROVED_SCOPE";
  return windowOpen ? "FREE_TEXT" : "TEMPLATE_ONLY";
}

/** Templates the firm may send outside the window (docs/architecture-integrations.md §4.3). */
export const BROKER_TEMPLATES = ["legajo_escalado", "legajo_recordatorio"] as const;
export type BrokerTemplate = (typeof BROKER_TEMPLATES)[number];

/** Longest free text the console lets the firm send in one message. */
export const BROKER_TEXT_MAX = CONSOLE_TEXT_MAX;
