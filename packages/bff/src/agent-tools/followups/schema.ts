// Target `followups` (`ToolFollowups`, docs/tool-catalog.md): the agent's own follow-ups and the delay
// risk with the firm's labelled assumptions. `overrideAssumptions` is declared only so the Cedar forbid
// CED-RISK-ASSUMPTIONS can fire; zod refuses it with any value. The zod here is the only source of the
// Gateway schema of these two tools.
import { z } from "zod";
import { Party } from "@legajo/shared";
import { ZonedInstant } from "../../domain/common";
import { CONSOLE_CALLERS, defineTool, deniedByPolicy } from "../common/define";

/** Why the agent follows up (`schedule_followup.reason`). */
export const FollowupReason = z.enum(["PROMISED_BY_SUPPLIER", "IMPORTER_ASKED_LATER", "OTHER"]);
export type FollowupReason = z.infer<typeof FollowupReason>;

export const FOLLOWUPS_TOOLS = {
  schedule_followup: defineTool({
    name: "schedule_followup",
    description:
      "Schedules a follow-up turn of this operation at a simulated instant, moved to the party's next business hours. At most two open follow-ups per operation and never after the ESCALATION milestone; when it falls due, a FOLLOWUP_DUE turn opens unless the document already arrived.",
    fields: {
      party: Party.extract(["IMPORTER", "SUPPLIER"]).describe("Who the follow-up is about."),
      atSim: ZonedInstant.describe("ISO 8601 instant with its zone, in simulated time, taken from a tool result or from what the party said."),
      reason: FollowupReason.describe("Why."),
    },
    callers: [],
  }),

  estimate_delay_risk: defineTool({
    name: "estimate_delay_risk",
    description:
      "Estimates the risk of arriving without the documents: missing documents, hours to the ETA, days at risk and cost range, with the firm's assumptions. Its text already labels every assumption and its source: quote it as it is.",
    fields: {
      overrideAssumptions: deniedByPolicy("object", "CED-RISK-ASSUMPTIONS"),
    },
    callers: ["WORKER", ...CONSOLE_CALLERS],
  }),
} as const;
