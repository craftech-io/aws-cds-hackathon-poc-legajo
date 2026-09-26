// Target `messaging` (`ToolMessaging`, docs/tool-catalog.md): the only ways the agent speaks (ADR-0011).
// Recipients never come from the input (`LAM-RECIPIENT`): `recipientRole` exists so the Cedar fences
// (CED-WA-IMPORTER-ONLY, CED-EMAIL-SUPPLIER-ONLY) can read it, and the outbound pipeline resolves the
// registered phone or the ACTIVE contact itself. The zod here is the only source of the Gateway schema
// of these three tools.
import { z } from "zod";
import { ContactId, DocType, MessageId, MessageKind, ObservationId, OperationNumber, SupplierEmailKind, WaButtonAction, WhatsAppTemplateName } from "@legajo/shared";
import { CONSOLE_CALLERS, boundedText, defineTool } from "../common/define";

/** WhatsApp allows three reply buttons per message. */
export const MAX_BUTTONS = 3;

const MessageRefs = z
  .object({
    docTypes: z.array(DocType).max(3).optional().describe("Documents the message is about."),
    observationIds: z.array(ObservationId).max(10).optional().describe("Observations of this operation the message is about."),
  })
  .strict();

const Template = z
  .object({
    name: WhatsAppTemplateName.describe("Approved template."),
    params: z.array(boundedText(200, "One parameter.")).max(10).optional().describe("Parameters in order, each copied from a tool result of this turn."),
  })
  .strict();

const Button = z
  .object({
    action: WaButtonAction.describe("What the button does; the code writes its title."),
    operationNumber: OperationNumber.optional().describe("This operation's number."),
  })
  .strict();

export const MESSAGING_TOOLS = {
  send_whatsapp: defineTool({
    name: "send_whatsapp",
    description:
      "Sends a WhatsApp message to the importer of this operation (its registered phone; the recipient never comes from the input). Free text only inside the importer's 24-hour window; outside it, an approved template whose parameters are copied from this turn's tool results. REMINDER only in milestone or follow-up turns. Every message goes through the contact policy, the grounding check and the recipient fence; the answer says SENT or DEFERRED (it goes out later by itself: never resend it).",
    fields: {
      recipientRole: z.literal("IMPORTER").describe("WhatsApp only goes to the importer of this operation (CED-WA-IMPORTER-ONLY)."),
      kind: MessageKind.describe("Kind of message; the contact policy decides whether it may go out now."),
      text: boundedText(900, "Free text in Rioplatense Spanish, only inside the 24-hour window.").optional(),
      template: Template.optional().describe("Approved template, the only way to write outside the 24-hour window."),
      buttons: z.array(Button).max(MAX_BUTTONS).optional().describe("Reply buttons."),
      refs: MessageRefs.optional().describe("What the message is about."),
    },
    callers: ["WORKER", ...CONSOLE_CALLERS],
    // A reminder never stands in for an acknowledgement or a reply the window does not let out
    // (docs/design-brief.md §5.7, "Acuse de una carga por link").
    triggers: (input) => (input.kind === "REMINDER" ? ["MILESTONE", "FOLLOWUP_DUE"] : undefined),
  }),

  send_email: defineTool({
    name: "send_email",
    description:
      "Sends an email in English to the supplier of this operation, to its ACTIVE contact (subject, sender and headers are written by the code). Needs the importer's authorization and a confirmed contact. The body must carry the invoice number and, when there is one, the supplier's deadline exactly as get_dossier returned it. The answer says SENT or DEFERRED (it goes out later by itself: never resend it).",
    fields: {
      recipientRole: z.literal("SUPPLIER").describe("Email only goes to the supplier of this operation (CED-EMAIL-SUPPLIER-ONLY)."),
      kind: SupplierEmailKind.describe("Kind of email."),
      contactId: ContactId.optional().describe("A contact of this operation's supplier from get_counterpart_profile; by default the ACTIVE contact that works."),
      text: boundedText(2500, "Body in English."),
      refs: MessageRefs.describe("What the email is about."),
    },
    callers: ["WORKER"],
  }),

  propose_supplier_contact: defineTool({
    name: "propose_supplier_contact",
    description:
      "Proposes a supplier email address that the importer wrote in their message of this turn. The importer confirms it with a button before anyone writes to it; until then mail from that address is quarantined. If the address is refused, escalate.",
    fields: {
      email: z.email().max(254).describe("The address exactly as the importer wrote it."),
      sourceMessageId: MessageId.describe("Id of the importer's message of this turn that contains the address."),
    },
    callers: [],
    triggers: () => ["IMPORTER_MESSAGE"],
  }),
} as const;
