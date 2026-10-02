// `TIMER#BOUNCE_RETRY` (docs/architecture.md §8, "Reenvío único"): four simulated hours after a
// transient bounce (`apply_email_event`), the email to the supplier is sent once more through the
// outbound pipeline, so the policy, the recipient fence and the contact's state decide it again at that
// instant (a contact that bounced for good in between is refused by `CP-BOUNCED-CONTACT`).
//
// Only a message that is still `DELAYED` is resent: one SES delivered after all, or one that bounced for
// good, is left as it is. The text is the one the pipeline already verified and sent (`Message.body`),
// resent verbatim by the code (`textSource CODE`: foreign links and sensitive asks are checked again;
// grounding is not, because its turn may be gone). The new message id derives from the delayed one, so
// a retried firing never sends twice.
import { z } from "zod";
import { ContactId, MessageId, SupplierEmailKind } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import { type OutboundSender, derivedMessageId } from "../../escalations/ports";
import type { Logger } from "../../lib/log";
import type { SupplierEmailSend } from "../../outbound/types";
import type { TimerAction } from "../../timers/fire";

/** `payload` of a `TIMER#BOUNCE_RETRY` (services/conversation-control/email-event.ts). */
export const BounceRetryPayload = z.object({ messageId: MessageId, contactId: ContactId.optional() }).strict();

export interface BounceRetryDeps {
  readonly data: Pick<Connector, "conversations">;
  readonly send: OutboundSender;
  readonly log: Logger;
}

/** The message id of the one resend of a delayed email. */
export function bounceRetryMessageId(messageId: string): string {
  return derivedMessageId("BOUNCE_RETRY", messageId);
}

export function bounceRetryAction(deps: BounceRetryDeps): TimerAction {
  return async ({ timer, firing }) => {
    const payload = BounceRetryPayload.safeParse(timer.payload);
    if (!payload.success) return { outcome: "SKIPPED", reason: "PAYLOAD_INVALID" };
    const message = await deps.data.conversations.getMessage(timer.operationId, payload.data.messageId);
    if (message === undefined || message.clockId !== timer.clockId || message.direction !== "OUT" || message.channel !== "EMAIL" || message.counterpart !== "SUPPLIER") {
      return { outcome: "SKIPPED", reason: "MESSAGE_GONE" };
    }
    if (message.status !== "DELAYED") return { outcome: "SKIPPED", reason: "MESSAGE_SETTLED" };
    const kind = SupplierEmailKind.safeParse(message.kind);
    if (!kind.success) return { outcome: "SKIPPED", reason: "KIND_NOT_RESENT" };
    const messageId = bounceRetryMessageId(message.messageId);
    const request: SupplierEmailSend = {
      operationId: message.operationId,
      channel: "EMAIL",
      counterpart: "SUPPLIER",
      kind: kind.data,
      author: message.author,
      textSource: "CODE",
      eventAtSim: firing.eventAtSim,
      text: message.body,
      messageId,
      ...(message.contactId === undefined ? {} : { contactId: message.contactId }),
      refs: { ...(message.refs.docTypes === undefined ? {} : { docTypes: message.refs.docTypes }), ...(message.refs.observationIds === undefined ? {} : { observationIds: message.refs.observationIds }) },
    };
    const result = await deps.send(request, {
      actor: "SYSTEM",
      correlationId: firing.correlationId ?? firing.eventId ?? messageId,
      log: deps.log,
      refs: { operationId: message.operationId, messageId: message.messageId },
    });
    return { outcome: "FIRED", detail: { resentAs: messageId, sendStatus: result.status } };
  };
}
