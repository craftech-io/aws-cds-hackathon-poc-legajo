// The fixed tables the rules read (docs/design-brief.md §3 and §5.7): which recipient and channel
// each `MessageKind` goes to (`CP-KIND-CHANNEL`), what an approved dossier may still send
// (`CP-APPROVED-SCOPE`), which kinds the daily cap counts (`CP-ONE-PER-DAY`) and what makes a send a
// reply to the importer (the exemption of `CP-HOURS-AR`, and the `REPLY` an approved dossier admits).
import type { Channel, MessageKind, TurnTrigger } from "@legajo/shared";
import type { Counterpart, MessageStatus } from "../domain/conversations";

export type Route = `${Counterpart}:${Channel}`;

export const TO_IMPORTER: Route = "IMPORTER:WHATSAPP";
export const TO_SUPPLIER: Route = "SUPPLIER:EMAIL";
export const TO_FIRM: Route = "FIRM:EMAIL";

/**
 * Kind → recipient and channel. `REPLY` also answers a supplier by email (`send_email` accepts it);
 * `ESCALATION` goes to the firm's mailbox (the console shows it without a message). A
 * `CORRECTION_REQUEST` reaches the importer only when the importer is responsible (checked apart).
 */
export const KIND_ROUTES: Readonly<Record<MessageKind, readonly Route[]>> = {
  DOCS_REQUEST: [TO_IMPORTER, TO_SUPPLIER],
  REMINDER: [TO_IMPORTER, TO_SUPPLIER],
  CORRECTION_REQUEST: [TO_SUPPLIER, TO_IMPORTER],
  NO_ACTION_NEEDED: [TO_IMPORTER],
  CONTACT_REQUEST: [TO_IMPORTER],
  CONTACT_CONFIRMATION: [TO_IMPORTER],
  UPLOAD_LINK: [TO_IMPORTER],
  ETA_CHANGE: [TO_IMPORTER, TO_SUPPLIER],
  ESCALATION_NOTICE: [TO_IMPORTER],
  ESCALATION: [TO_FIRM],
  APPROVAL_NOTICE: [TO_IMPORTER],
  DISPATCH_STATUS: [TO_IMPORTER],
  REPLY: [TO_IMPORTER, TO_SUPPLIER],
  BROKER_MESSAGE: [TO_IMPORTER],
  OPT_OUT_CONFIRMATION: [TO_IMPORTER],
  OPERATION_CHOICE: [TO_IMPORTER],
};

/** The only WhatsApp that still goes out after an opt-out (`CP-OPTOUT`). */
export const OPT_OUT_CONFIRMATION: MessageKind = "OPT_OUT_CONFIRMATION";

/** What an approved dossier still sends the importer, besides a reply to the importer's own message. */
export const APPROVED_IMPORTER_KINDS: readonly MessageKind[] = ["APPROVAL_NOTICE", "DISPATCH_STATUS", OPT_OUT_CONFIRMATION];

/** Kinds `CP-ONE-PER-DAY` counts: at most one of them per contact and simulated day. */
export const ONCE_A_DAY_KINDS: readonly MessageKind[] = ["DOCS_REQUEST", "REMINDER"];

/** Turns opened by a WhatsApp message of the importer (a text, a button reply or an attachment). */
export const REPLY_TRIGGERS: readonly TurnTrigger[] = ["IMPORTER_MESSAGE", "CONTACT_CONFIRMED"];

/** Kinds that only exist as the deterministic answer to a message of the importer. */
export const ANSWER_ONLY_KINDS: readonly MessageKind[] = [OPT_OUT_CONFIRMATION, "OPERATION_CHOICE"];

/** Statuses of an outbound message that left the building (queued, deferred or failed ones never did). */
const WENT_OUT_STATUSES: ReadonlySet<MessageStatus> = new Set(["SENT", "DELIVERED", "READ", "DELAYED", "BOUNCED", "COMPLAINED"]);

export function wentOut(message: { readonly direction: string; readonly status: MessageStatus }): boolean {
  return message.direction === "OUT" && WENT_OUT_STATUSES.has(message.status);
}
