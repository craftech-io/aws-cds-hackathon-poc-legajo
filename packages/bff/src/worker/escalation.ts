// Deterministic escalations from the worker (docs/design-brief.md §5.8, docs/architecture.md §7):
// `escalate_to_broker` of the `handoff` target, imported in process with `caller WORKER` (the same
// wrapper, strict input and audit as a Gateway call, docs/tool-catalog.md). It keeps one open escalation
// per reason and operation, and decides the email to the firm's mailbox with its caps, the daily cap of
// `UNTRUSTED_SENDER` emails per firm included (`Firms/SETTINGS.untrustedSenderEmailsPerDay`).
//
// Two callers here: an `ESCALATE` event of the channel entries (`UNTRUSTED_SENDER`, `OPTED_OUT`) and the
// guardrail block of a turn (worker/guardrail-block.ts). The summary is always a fixed text of copy/:
// never the blocked text, never a personal datum.
import { z } from "zod";
import { ToolError } from "@legajo/shared";
import type { GatewayTargetRuntime } from "../agent-tools/common/handler";
import { labelsEsAR } from "../copy/es-AR";
import { EscalationId } from "../domain/operations";
import type { EscalateEvent } from "./events";
import type { EscalationPort } from "./ports";

const Escalated = z.object({ ok: z.literal(true), escalationId: EscalationId }).loose();

/** The port over the in-process `handoff` target; a refusal of the tool fails the event (SQS retries it). */
export function handoffEscalation(target: Pick<GatewayTargetRuntime, "invoke">): EscalationPort {
  return {
    async escalate(request) {
      const response = await target.invoke("escalate_to_broker", {
        caller: { kind: "WORKER", firmId: request.firmId, eventId: request.eventId },
        operationId: request.operationId,
        reason: request.reason,
        summary: request.summary,
      });
      if (!response.ok) throw new ToolError(response.error.code, `escalate_to_broker answered ${response.error.code}`, response.error.reason);
      const parsed = Escalated.safeParse(response);
      if (!parsed.success) throw new ToolError("UNAVAILABLE", "escalate_to_broker answered without an escalation id");
      return { escalationId: parsed.data.escalationId };
    },
  };
}

/** `ESCALATE`: the channel already decided the reason; the summary is its fixed label. */
export async function escalateEvent(escalation: EscalationPort, event: EscalateEvent): Promise<void> {
  await escalation.escalate({ operationId: event.operationId, firmId: event.firmId, eventId: event.eventId, reason: event.reason, summary: labelsEsAR.escalationReason[event.reason] });
}
