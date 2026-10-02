// Shapes of the copy packs. The Spanish pack (es-AR.ts, es-AR-firm.ts) and its English gloss
// (en-gloss.ts, en-gloss-firm.ts) implement the same interfaces, so a text without a gloss, or a gloss
// without a text, is a compile error rather than a missing "EN" in the phone simulator. Every text a
// party reads comes from copy/: no tool, adapter, worker or prompt carries an inline string.
import type {
  DocStatus,
  DocType,
  DossierStatus,
  EscalationReason,
  MessageKind,
  ObservationCode,
  Party,
  SendChannel,
  WaButtonAction,
} from "@legajo/shared";

export interface EmailText {
  readonly subject: string;
  readonly body: string;
}

/** Public words for the enums a person reads (CONTEXT.md vocabulary), one set per language. */
export interface Labels {
  readonly docType: Readonly<Record<DocType, string>>;
  readonly docStatus: Readonly<Record<DocStatus, string>>;
  readonly dossierStatus: Readonly<Record<DossierStatus, string>>;
  readonly party: Readonly<Record<Party, string>>;
  readonly channel: Readonly<Record<SendChannel, string>>;
  readonly messageKind: Readonly<Record<MessageKind, string>>;
  readonly escalationReason: Readonly<Record<EscalationReason, string>>;
}

export interface OperationChoiceRowParams {
  readonly supplierName: string;
  readonly etaText: string;
}

/** Fixed WhatsApp texts the system (never the model) sends to the importer, `author SYSTEM`. */
export interface ImporterTexts {
  /**
   * Reply to an importer message that G1 blocked (docs/architecture.md §9.1). There is no supplier
   * counterpart on purpose: a block of supplier origin answers nobody.
   */
  readonly guardrailRefusal: string;
  /** Phone number without an importer (FL-093): no data, no names, no operation. */
  readonly unknownSender: string;
  /** One message over `settings.rateLimitPerHour` (FL-094). */
  readonly rateLimited: string;
  /** Image, audio, video, sticker or any other non-PDF media (FL-018). */
  readonly rejectedMedia: string;
  /** A PDF over the 10 MB intake limit. */
  readonly mediaTooLarge: string;
  /** `OPT_OUT_CONFIRMATION`, the only WhatsApp allowed after an opt-out (CP-OPTOUT, FL-016). */
  readonly optOutConfirmation: string;
  /** Follow-up question after the `QUESTION` button (FL-045). */
  readonly questionPrompt: string;
  /** `CONTACT_CONFIRMATION` body; the address only ever appears masked (CP-NO-FOREIGN-LINKS). */
  readonly contactConfirmation: (params: { readonly maskedEmail: string }) => string;
  /** `OPERATION_CHOICE` list (FL-019): body and the description under each row title. */
  readonly operationChoice: {
    readonly body: string;
    readonly rowDescription: (params: OperationChoiceRowParams) => string;
  };
}

export interface DocumentLine {
  readonly docType: DocType;
  readonly status: DocStatus;
  readonly responsible?: Party;
}

export interface AttemptLine {
  /** Simulated time, already formatted in Argentina's zone by the caller. */
  readonly atText: string;
  readonly channel: SendChannel;
  readonly recipient: Party;
  readonly kind: MessageKind;
}

export interface EscalationEmailParams {
  readonly operationNumber: string;
  readonly importerName: string;
  readonly supplierName: string;
  readonly reason: EscalationReason;
  /** Summary of the escalation (agent's, or a fixed one of `FirmTexts.guardrailSummary`). */
  readonly summary: string;
  readonly dossierStatus: DossierStatus;
  readonly etaText: string;
  readonly documents: readonly DocumentLine[];
  readonly attempts: readonly AttemptLine[];
  /** `estimate_delay_risk.text`, which already carries the word "supuesto" and its source. */
  readonly riskText?: string;
  /** Link to the operation in the console, on the stage domain. */
  readonly consoleUrl: string;
}

export interface ReadyForReviewEmailParams {
  readonly operationNumber: string;
  readonly importerName: string;
  readonly supplierName: string;
  /** `request_approval.summary`: how each observation was resolved. */
  readonly summary: string;
  readonly consoleUrl: string;
}

/** Emails from `avisos@` to the firm's mailbox, and the fixed escalation summaries. */
export interface FirmTexts {
  readonly escalationEmail: (params: EscalationEmailParams) => EmailText;
  readonly readyForReviewEmail: (params: ReadyForReviewEmailParams) => EmailText;
  /** `request_approval` summary when a decision of the firm left the dossier complete (worker caller). */
  readonly completedByFirm: string;
  /** Fixed `summary` of the escalation that follows a G1 block (docs/architecture.md §9.1). */
  readonly guardrailSummary: {
    readonly promptAttack: string;
    readonly cardData: string;
  };
}

/** A button title in the two lengths WhatsApp allows, so no adapter ever truncates at send time. */
export interface ButtonLabel {
  /** Quick reply or URL button of an approved template, ≤ 25 characters. */
  readonly template: string;
  /** Reply button of an interactive message (≤ 20) or the button that opens a list. */
  readonly interactive: string;
}

export type TemplateButton =
  | { readonly type: "URL"; readonly action: "UPLOAD"; readonly text: string; readonly url: string }
  | { readonly type: "QUICK_REPLY"; readonly action: Exclude<WaButtonAction, "UPLOAD" | "CHOOSE_OPERATION">; readonly text: string };

export interface TemplateParam {
  /** What the caller must pass at this position, taken from a tool result of the turn. */
  readonly name: string;
  /** Sample value Meta asks for when the template is registered. */
  readonly example: string;
}

export interface ObservationLabel {
  /** Short Spanish label (`Reference/OBS_CODE`, console, tool results). */
  readonly es: string;
  /** Short English label. */
  readonly en: string;
  /** Spanish noun phrase of what has to be fixed ("el peso bruto"), before "del packing list". */
  readonly esField: string;
  /** English words for the correction subject ("gross weight"), after the document label. */
  readonly enSubject: string;
}

export type ObservationLabels = Readonly<Record<ObservationCode, ObservationLabel>>;
