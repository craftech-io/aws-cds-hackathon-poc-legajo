// Target `handoff` (`ToolHandoff`, docs/tool-catalog.md): handing the operation to the firm and asking it
// to review the dossier. No tool approves (ADR-0010): `decision` is declared only so the Cedar forbid
// CED-NO-APPROVE can fire, and zod refuses it with any value. The zod here is the only source of the
// Gateway schema of these two tools.
import { z } from "zod";
import { AgentEscalationReason, EscalationReason } from "@legajo/shared";
import { boundedText, defineTool, deniedByPolicy } from "../common/define";

export const HANDOFF_TOOLS = {
  escalate_to_broker: defineTool({
    name: "escalate_to_broker",
    description:
      "Hands this operation to the firm with a reason and a summary. One open escalation per reason (a second call returns the open one). With notifyImporter the importer gets the approved legajo_escalado template.",
    fields: {
      reason: AgentEscalationReason.describe("OUT_OF_CHECKLIST for a question the checklist does not cover or a topic the firm answers; IMPORTER_ASKED when the importer wants a person; OTHER for anything else."),
      summary: boundedText(500, "What happened and what is pending, without personal data."),
      notifyImporter: z.boolean().optional().describe("Tell the importer that a person of the firm will follow up."),
    },
    callers: ["WORKER"],
    // The worker escalates with every deterministic reason of docs/design-brief.md §5.8.
    directFields: { reason: EscalationReason },
  }),

  request_approval: defineTool({
    name: "request_approval",
    description:
      "Marks the dossier READY_FOR_REVIEW when every document is valid (or its observation was waived by the firm) and emails the firm that it is ready. It never approves: approving is a human decision in the firm's console. Answers NOT_COMPLETE otherwise.",
    fields: {
      summary: boundedText(800, "How each observation was resolved."),
      decision: deniedByPolicy("string", "CED-NO-APPROVE"),
    },
    callers: ["WORKER"],
  }),
} as const;
