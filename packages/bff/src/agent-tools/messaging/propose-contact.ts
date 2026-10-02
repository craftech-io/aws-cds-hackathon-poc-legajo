// `propose_supplier_contact` (docs/tool-catalog.md; FL-014 and FL-015): the importer wrote another
// address of its supplier, and the agent proposes it. Only in an `IMPORTER_MESSAGE` turn (the wrapper's
// `LAM-TRIGGER`). In order:
//
//   1. evidence   `sourceMessageId` is an inbound WhatsApp of this operation's importer and carries the
//                 address as written (`LAM-EVIDENCE`): the model cannot make an address up
//   2. world      the registry rules of the operation's world (services/contacts/address-rules.ts: a
//                 guest world only takes simulated mailboxes, `qa-` prefixes, the injector)
//   3. fence      the SYSTEM fence the pipeline would write to it with, from the operation's thread
//                 address (`CP-RECIPIENT-FENCE`); refused → `RECIPIENT_NOT_ALLOWED` and the agent escalates
//   4. contact    `PENDING_CONFIRMATION` with its `ADDR#` claim and the message it came from; a claimed
//                 address (another contact, another firm) is a `CONFLICT`
//   5. question   the fixed text of copy/ with the masked address and the buttons `CONFIRM_CONTACT` /
//                 `REJECT_CONTACT` (their nonces carry the contact) through the outbound pipeline
//
// Until the importer's button (or the console) confirms it, mail from that address is quarantined
// (`UNTRUSTED_SENDER`). A question the pipeline refuses leaves no contact behind.
import { type RuleId, ToolError, fail, maskEmail, ok } from "@legajo/shared";
import { parseAddress } from "../../channels/email/address";
import { importerEsAR } from "../../copy/es-AR";
import { sendOutbound } from "../../outbound/pipeline";
import { proposedContactFence } from "../../outbound/recipient-fence";
import { checkPartyEmail } from "../../services/contacts/address-rules";
import type { ToolContext, ToolImplementation, ToolResponse } from "../common/context";
import type { ToolInput } from "../common/define";
import type { MESSAGING_TOOLS } from "./schema";
import { type MessagingPorts, answerOf, originOf, outboundCall } from "./send";

type ProposeInput = ToolInput<(typeof MESSAGING_TOOLS)["propose_supplier_contact"]>;

export const PROPOSE_REASON = {
  NOT_IMPORTER_MESSAGE: "SOURCE_NOT_IMPORTER_MESSAGE",
  ADDRESS_NOT_IN_MESSAGE: "ADDRESS_NOT_IN_MESSAGE",
  ALREADY_A_CONTACT: "ALREADY_A_CONTACT",
} as const;

async function refuse(ctx: ToolContext<ProposeInput>, failure: ReturnType<typeof fail>, ruleIds: readonly RuleId[], detail?: Readonly<Record<string, unknown>>): Promise<ToolResponse> {
  await ctx.audit({ decision: "DENY", action: "CONTACT_PROPOSED", ruleIds, ...(failure.error.reason === undefined ? {} : { reason: failure.error.reason }), ...(detail === undefined ? {} : { detail }) });
  ctx.log.warn("tool.denied", { rule: ruleIds[0], code: failure.error.code, reason: failure.error.reason });
  return failure;
}

/** Step 1: an inbound WhatsApp of this importer, in this operation, that carries the address. */
async function evidenceProblem(ctx: ToolContext<ProposeInput>, address: string): Promise<ReturnType<typeof fail> | undefined> {
  const { scope, input } = ctx;
  const source = await ctx.connector.conversations.getMessage(scope.operationId, input.sourceMessageId);
  if (source === undefined || source.direction !== "IN" || source.channel !== "WHATSAPP" || source.counterpart !== "IMPORTER" || source.importerId !== scope.importerId) {
    return fail("FORBIDDEN", "sourceMessageId is not a WhatsApp message of this operation's importer", PROPOSE_REASON.NOT_IMPORTER_MESSAGE);
  }
  if (!source.body.toLowerCase().includes(address)) return fail("FORBIDDEN", "the importer's message does not contain that address as written", PROPOSE_REASON.ADDRESS_NOT_IN_MESSAGE);
  return undefined;
}

export function proposeSupplierContact(ports: MessagingPorts): ToolImplementation<ProposeInput> {
  return async (ctx) => {
    const { scope, input } = ctx;
    const parsed = parseAddress(input.email);
    if (!parsed.ok) return refuse(ctx, fail("INVALID", "that is not an address the mail client accepts", "ADDRESS_INVALID"), ["LAM-STRICT"]);
    const address = parsed.value.address;
    const evidence = await evidenceProblem(ctx, address);
    if (evidence !== undefined) return refuse(ctx, evidence, ["LAM-EVIDENCE"]);
    try {
      checkPartyEmail(address, scope.clockId);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return refuse(ctx, fail(error.code, `${error.message}; escalate to the firm`, error.reason), ["CP-RECIPIENT-FENCE"]);
    }
    const deps = ports.outbound();
    const operation = await ctx.connector.operations.getOperation(scope.operationId);
    const fence = await proposedContactFence(deps.fence, operation, address);
    if (!fence.allowed) return refuse(ctx, fail("RECIPIENT_NOT_ALLOWED", "that address is outside the recipient fence; escalate to the firm", fence.reason ?? "RECIPIENT_NOT_ALLOWED"), ["CP-RECIPIENT-FENCE"], { fence: fence.reason });
    const emailHash = deps.emailHash(address);
    const known = (await ctx.connector.parties.listContacts(scope.supplierId)).find((contact) => contact.email === address);
    if (known !== undefined) return refuse(ctx, fail("CONFLICT", `that address is already a contact of this supplier (${known.status})`, PROPOSE_REASON.ALREADY_A_CONTACT), [], { contactId: known.contactId });
    if ((await ctx.connector.parties.getAddressClaim(emailHash)) !== undefined) return refuse(ctx, fail("CONFLICT", "that address belongs to another party; escalate to the firm", "CONFLICT"), []);
    const contact = await ctx.connector.parties.createContact({
      contactId: `ctc-${deps.newId().toLowerCase()}`,
      supplierId: scope.supplierId,
      firmId: scope.firmId,
      clockId: scope.clockId,
      email: address,
      emailHash,
      status: "PENDING_CONFIRMATION",
      sourceMessageId: input.sourceMessageId,
      created: { atSim: scope.nowSim, atReal: ctx.wallClock().toISOString(), by: "AGENT" },
    });
    await ctx.audit({ decision: "ACTION", action: "CONTACT_PROPOSED", ruleIds: ["LAM-EVIDENCE", "CP-RECIPIENT-FENCE"], refs: { contactId: contact.contactId, messageId: input.sourceMessageId } });
    const payload = { supplierId: scope.supplierId, contactId: contact.contactId };
    const result = await sendOutbound(
      deps,
      {
        ...originOf(ctx),
        textSource: "CODE",
        channel: "WHATSAPP",
        kind: "CONTACT_CONFIRMATION",
        answers: input.sourceMessageId,
        text: importerEsAR.contactConfirmation({ maskedEmail: maskEmail(address) }),
        buttons: [
          { action: "CONFIRM_CONTACT", payload },
          { action: "REJECT_CONTACT", payload },
        ],
      },
      outboundCall(ctx),
    );
    if (result.status === "REFUSED") {
      await ctx.connector.parties.discardContact(contact.supplierId, contact.contactId);
      return answerOf(result);
    }
    return ok({ contactId: contact.contactId, status: "PENDING_CONFIRMATION", confirmationMessageId: result.messageId });
  };
}
