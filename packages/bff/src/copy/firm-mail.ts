// Layout of the emails to the firm's mailbox, shared by the Spanish text (es-AR-firm.ts) and its
// English gloss (en-gloss.ts): each language only supplies its words and labels, so both render the
// same lines in the same order.
import { capitalize } from "./helpers";
import type { AttemptLine, DocumentLine, EscalationEmailParams, FirmTexts, Labels, ReadyForReviewEmailParams } from "./types";

export interface FirmWords {
  readonly escalationSubject: (params: { readonly operationNumber: string; readonly reasonLabel: string }) => string;
  readonly operationLine: (params: { readonly operationNumber: string; readonly importerName: string; readonly supplierName: string }) => string;
  readonly reasonLine: (reasonLabel: string) => string;
  readonly summaryLine: (summary: string) => string;
  readonly dossierLine: (params: { readonly statusLabel: string; readonly etaText: string }) => string;
  readonly responsible: string;
  readonly attemptsHeading: string;
  readonly noAttempts: string;
  /** Between the channel and the party: "WhatsApp al importador", "email to the supplier". */
  readonly to: string;
  readonly riskLine: (riskText: string) => string;
  readonly escalationFooter: string;
  readonly readySubject: (operationNumber: string) => string;
  readonly readyLead: string;
  readonly readySummaryHeading: string;
  readonly readyFooter: string;
  readonly completedByFirm: string;
  readonly guardrailSummary: FirmTexts["guardrailSummary"];
}

function documentLine(words: FirmWords, labels: Labels, line: DocumentLine): string {
  const responsible = line.responsible ? ` · ${words.responsible}: ${labels.party[line.responsible]}` : "";
  return `- ${capitalize(labels.docType[line.docType])} · ${labels.docStatus[line.status]}${responsible}`;
}

function attemptLine(words: FirmWords, labels: Labels, line: AttemptLine): string {
  return `- ${line.atText} · ${labels.channel[line.channel]} ${words.to} ${labels.party[line.recipient]} · ${labels.messageKind[line.kind]}`;
}

function escalationBody(words: FirmWords, labels: Labels, p: EscalationEmailParams): string {
  return [
    words.operationLine(p),
    words.reasonLine(labels.escalationReason[p.reason]),
    words.summaryLine(p.summary),
    "",
    words.dossierLine({ statusLabel: labels.dossierStatus[p.dossierStatus], etaText: p.etaText }),
    ...p.documents.map((line) => documentLine(words, labels, line)),
    "",
    words.attemptsHeading,
    ...(p.attempts.length === 0 ? [words.noAttempts] : p.attempts.map((line) => attemptLine(words, labels, line))),
    ...(p.riskText ? ["", words.riskLine(p.riskText)] : []),
    "",
    words.escalationFooter,
    p.consoleUrl,
  ].join("\n");
}

function readyBody(words: FirmWords, p: ReadyForReviewEmailParams): string {
  return [words.operationLine(p), words.readyLead, "", words.readySummaryHeading, p.summary, "", words.readyFooter, p.consoleUrl].join("\n");
}

export function buildFirmTexts(words: FirmWords, labels: Labels): FirmTexts {
  return {
    escalationEmail: (p) => ({
      subject: words.escalationSubject({ operationNumber: p.operationNumber, reasonLabel: labels.escalationReason[p.reason] }),
      body: escalationBody(words, labels, p),
    }),
    readyForReviewEmail: (p) => ({ subject: words.readySubject(p.operationNumber), body: readyBody(words, p) }),
    completedByFirm: words.completedByFirm,
    guardrailSummary: words.guardrailSummary,
  };
}
