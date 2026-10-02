// Contract of the outbound pipeline (docs/tool-catalog.md, target `messaging`; docs/design-brief.md
// §5.5 and §5.7): the one path every message that leaves the system takes, whoever asks for it — the
// three send tools of the agent, the worker (milestone fallback, deferred sends, the firm's messages,
// fixed replies) and `ToolHandoff` (escalations). The caller says what to say and to whom by role; the
// pipeline resolves the address from the registry (`LAM-RECIPIENT`), never from the caller.
import type { DocType, Guardrail, MessageKind, RuleId, SupplierEmailKind, ToolFailure, TurnTrigger, WaButtonAction, WhatsAppTemplateName } from "@legajo/shared";
import type { ContactNoncePayload } from "../channels/whatsapp/nonces";
import type { DecisionRefs } from "../domain/audit";
import type { Actor } from "../domain/common";
import type { Logger } from "../lib/log";
import type { PolicyDecision, WindowState } from "../policy/types";

/**
 * Who wrote the words: `MODEL` text is checked by G2 against the turn's tool results and by the
 * deterministic verification of facts; `CODE` text comes from `copy/` (fixed replies, notices) and
 * `PERSON` text from someone of the firm. Every free text, whoever wrote it, is checked for foreign
 * links and contacts (`CP-NO-FOREIGN-LINKS`) and sensitive asks (`CP-NO-SENSITIVE-ASK`).
 */
export type TextSource = "MODEL" | "CODE" | "PERSON";

export interface OutboundButton {
  readonly action: WaButtonAction;
  /** `CONFIRM_CONTACT` / `REJECT_CONTACT`: the contact the importer is asked about. */
  readonly payload?: ContactNoncePayload;
}

export interface MessageRefsInput {
  readonly docTypes?: readonly DocType[];
  readonly observationIds?: readonly string[];
}

interface RequestBase {
  readonly operationId: string;
  readonly kind: MessageKind;
  /** `Message.author` and the author the contact policy reads (`CP-CONTROL-BROKER` stops `AGENT`). */
  readonly author: Actor;
  readonly textSource: TextSource;
  /** The simulated instant the send is decided at: the event of the turn, or the world's now (ADR-0007). */
  readonly eventAtSim: string;
  /** Trigger of the turn (or the deterministic handler) that produced the send. */
  readonly trigger?: TurnTrigger;
  /** The turn whose tool results ground `MODEL` text (`Runtime/TURN#<turnId>`). */
  readonly turnId?: string;
  /** The importer's inbound message this send answers, when the caller knows it. */
  readonly answers?: string;
  readonly refs?: MessageRefsInput;
  /** A derived id (a redelivered event never sends twice); a new one otherwise. */
  readonly messageId?: string;
}

export interface WhatsAppSend extends RequestBase {
  readonly channel: "WHATSAPP";
  readonly text?: string;
  readonly template?: { readonly name: WhatsAppTemplateName; readonly params: readonly string[] };
  readonly buttons?: readonly OutboundButton[];
}

export interface SupplierEmailSend extends RequestBase {
  readonly channel: "EMAIL";
  readonly counterpart: "SUPPLIER";
  readonly kind: SupplierEmailKind;
  /** A contact of the operation's supplier; by default its ACTIVE contact that works. */
  readonly contactId?: string;
  readonly text: string;
}

export interface FirmEmailSend extends RequestBase {
  readonly channel: "EMAIL";
  readonly counterpart: "FIRM";
  /** Built by the caller from copy/ (es-AR-firm.ts): the firm's mailbox reads Spanish. */
  readonly subject: string;
  readonly text: string;
}

export type OutboundRequest = WhatsAppSend | SupplierEmailSend | FirmEmailSend;

/** Who asks and how the decision is recorded. */
export interface OutboundCall {
  /** `AuditLog.actor`: the agent for a session, the code for the worker, the broker for the console. */
  readonly actor: Actor;
  readonly correlationId: string;
  readonly log: Logger;
  /** References every decision of the call carries (turn, event, broker). */
  readonly refs?: DecisionRefs;
}

interface Decided {
  readonly messageId: string;
  /** Absent only for a replay: a redelivered request whose message already exists is answered from it. */
  readonly decision?: PolicyDecision;
  readonly guardrail?: Guardrail;
  readonly replayed?: true;
}

export interface OutboundSent extends Decided {
  readonly status: "SENT";
  readonly providerMessageId?: string;
  readonly window?: WindowState;
  readonly templateUsed?: WhatsAppTemplateName;
}

export interface OutboundDeferred extends Decided {
  readonly status: "DEFERRED";
  /** Zoned instant of the side that decides (`CP-HOURS-*`, `CP-ONE-PER-DAY`). */
  readonly nextAllowedAt: string;
  /** The IANA zone of the side that decides (texts.ts), for the `deferredUntilText` the tools answer. */
  readonly zone?: string;
  readonly timerKey: string;
  readonly window?: WindowState;
}

export interface OutboundRefused {
  readonly status: "REFUSED";
  readonly failure: ToolFailure;
  readonly ruleIds: readonly RuleId[];
  readonly decision?: PolicyDecision;
  readonly guardrail?: Guardrail;
  readonly window?: WindowState;
}

export type OutboundResult = OutboundSent | OutboundDeferred | OutboundRefused;

/** `reason` of the refusals the pipeline answers itself (the policy's carry their rule). */
export const OUTBOUND_REASON = {
  GROUNDING_FAIL: "GROUNDING_FAIL",
  GUARDRAIL_UNAVAILABLE: "GUARDRAIL_UNAVAILABLE",
  NO_RECIPIENT: "NO_RECIPIENT",
  CONTENT_INVALID: "CONTENT_INVALID",
  SEND_FAILED: "SEND_FAILED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  DEFERRED_PAYLOAD_INVALID: "DEFERRED_PAYLOAD_INVALID",
  RESERVED_BUTTON: "RESERVED_BUTTON",
} as const;

/** Actions of the `AuditLog` rows the pipeline writes. */
export const OUTBOUND_ACTION = {
  EMAIL: "SEND_EMAIL",
  WHATSAPP: "SEND_WHATSAPP",
  DEFERRED: "DEFERRED_SEND",
} as const;
