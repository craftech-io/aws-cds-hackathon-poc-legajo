// `confirm_supplier_contact` (docs/tool-catalog.md, FL-011, FL-012, FL-014): a supplier contact the
// agent proposed (`PENDING_CONFIRMATION`) becomes `ACTIVE`, or goes away, by a person's decision only.
//
//   channel   the importer's one-shot nonce `CONFIRM_CONTACT` / `REJECT_CONTACT` (the channel resolved
//             it): `confirmedBy IMPORTER` and `AGENT_TURN(CONTACT_CONFIRMED)` for the operation the
//             nonce names, its id derived from the `wamid` (a redelivery enqueues nothing new); a
//             rejection discards the contact and its address claim;
//   console   and QA: `confirmedBy BROKER`, and the turn for every operation of the supplier the agent
//             still works on, its id derived from the contact (a contact is confirmed once).
//
// The console confirming a contact that is `ACTIVE` already changes nothing; the importer's button
// about the contact that already works (the agent's `CONTACT_CONFIRMATION`, FL-011) stamps
// `confirmedBy IMPORTER` and opens the turn. A contact that bounced or complained is never confirmed
// again (`CONFLICT`). `ACTION CONTACT_CONFIRMED` / `CONTACT_REJECTED`.
import { z } from "zod";
import { ContactConfirmInput, ImporterId, MessageId, OperationId, SupplierId, ToolError } from "@legajo/shared";
import { channelEvent, turnEventId } from "../../channels/adapter";
import { ZonedInstant } from "../../domain/common";
import { ACTIVE_DOSSIER_STATUSES } from "../../domain/operations";
import type { SupplierContact } from "../../domain/parties";
import { type DirectContext, createDirectHandler } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";
import { registryWorld } from "../operations-admin/world-scope";
import { contactView } from "./suppliers";

/** What the channel brings: the decision and the operation of the one-shot nonce. */
const ChannelDecision = z
  .object({
    operationId: OperationId,
    importerId: ImporterId,
    supplierId: SupplierId,
    decision: z.enum(["CONFIRM", "REJECT"]),
    /** The importer's `Message IN` (the button tap). */
    messageId: MessageId,
    wamid: z.string().min(1).max(256),
    atSim: ZonedInstant,
  })
  .strict();

export const ConfirmContactInput = ContactConfirmInput.extend({ channel: ChannelDecision.optional() }).strict();
type ConfirmInput = z.output<typeof ConfirmContactInput>;

/** The contact of the caller's world: the channel names its supplier; the console only the contact. */
async function contactOf(ctx: DirectContext<ConfirmInput>, firmId: string | undefined): Promise<SupplierContact> {
  const { input } = ctx;
  const { parties } = ctx.connector;
  if (input.channel !== undefined) {
    const contact = await parties.findContact(input.channel.supplierId, input.contactId);
    if (contact === undefined) throw new ToolError("NOT_FOUND", "unknown contact", "CONTACT_NOT_FOUND");
    return contact;
  }
  if (firmId === undefined) throw new ToolError("FORBIDDEN", "the console acts for a firm", "NO_FIRM");
  const clockId = await registryWorld(ctx, firmId, input.clockId);
  for (const supplier of await parties.listSuppliers(firmId, { clockId })) {
    const contact = await parties.findContact(supplier.supplierId, input.contactId);
    if (contact !== undefined) return contact;
  }
  throw new ToolError("NOT_FOUND", "unknown contact", "CONTACT_NOT_FOUND");
}

/** The operations whose agent waits for this contact: the nonce's, or every open one of the supplier. */
async function waitingOperations(ctx: DirectContext<ConfirmInput>, contact: SupplierContact): Promise<string[]> {
  if (ctx.input.channel !== undefined) {
    const operation = await ctx.connector.operations.getOperation(ctx.input.channel.operationId);
    if (operation.supplierId !== contact.supplierId || operation.clockId !== contact.clockId) throw new ToolError("FORBIDDEN", "the contact is not of this operation's supplier", "CONTACT_NOT_OF_OPERATION");
    return [operation.operationId];
  }
  const operations = await ctx.connector.operations.listOperations(contact.firmId, { statuses: ACTIVE_DOSSIER_STATUSES, clockId: contact.clockId });
  return operations.filter((operation) => operation.supplierId === contact.supplierId).map((operation) => operation.operationId);
}

export function confirmSupplierContactHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "confirm_supplier_contact",
      input: ConfirmContactInput,
      callers: ["CHANNEL", "CONSOLE", "QA"],
      async run(ctx) {
        const { input, caller } = ctx;
        const fromChannel = caller.kind === "CHANNEL";
        if (fromChannel !== (input.channel !== undefined)) throw new ToolError("INVALID", "only the channel brings the importer's decision", "CHANNEL_ORIGIN");
        const contact = await contactOf(ctx, caller.firmId);
        await ctx.fence(contact.firmId, { kind: "supplier", id: contact.supplierId });
        if (input.clockId !== undefined && input.clockId !== contact.clockId) throw new ToolError("INVALID", "the contact is not of the world named", "WORLD_MISMATCH");
        const atSim = input.channel?.atSim ?? (await ctx.world(contact.clockId)).atSim;
        const decision = input.channel?.decision ?? "CONFIRM";

        if (decision === "REJECT") {
          if (contact.status !== "PENDING_CONFIRMATION") return { contact: contactView(contact), changed: false, turns: 0 };
          await ctx.connector.parties.discardContact(contact.supplierId, contact.contactId, contact.version);
          await ctx.audit({ firmId: contact.firmId, decision: "ACTION", action: "CONTACT_REJECTED", clockId: contact.clockId, atSim, ...(input.channel === undefined ? {} : { operationId: input.channel.operationId, messageId: input.channel.messageId, trigger: "IMPORTER_MESSAGE" }), refs: { supplierId: contact.supplierId, contactId: contact.contactId } });
          return { contact: { ...contactView(contact), status: "DISCARDED" as const }, changed: true, turns: 0 };
        }

        // The console confirming an ACTIVE contact changes nothing; the importer's button about the
        // contact that already works (FL-011, FL-012) records the importer's confirmation and its turn.
        // A redelivered tap finds its own entry in the history and changes nothing again.
        const buttonReason = input.channel === undefined ? undefined : `IMPORTER_BUTTON ${input.channel.messageId}`;
        const repeated = buttonReason !== undefined && contact.statusHistory.some((entry) => entry.reason === buttonReason);
        if (contact.status === "ACTIVE" && (!fromChannel || repeated)) return { contact: contactView(contact), changed: false, turns: 0 };
        if (contact.status !== "PENDING_CONFIRMATION" && contact.status !== "ACTIVE") throw new ToolError("CONFLICT", "a contact that bounced or complained is never confirmed again", "CONTACT_FINAL");
        const operationIds = await waitingOperations(ctx, contact);
        const confirmed = await ctx.connector.parties.transitionContact({
          supplierId: contact.supplierId,
          contactId: contact.contactId,
          to: "ACTIVE",
          confirmedBy: fromChannel ? "IMPORTER" : "BROKER",
          atSim,
          atReal: ctx.now().toISOString(),
          by: fromChannel ? "IMPORTER" : ctx.actor,
          ...(buttonReason === undefined ? {} : { reason: buttonReason }),
          expectedVersion: contact.version,
        });
        await ctx.audit({
          firmId: contact.firmId,
          decision: "ACTION",
          action: "CONTACT_CONFIRMED",
          clockId: contact.clockId,
          atSim,
          ...(input.channel === undefined ? {} : { operationId: input.channel.operationId, messageId: input.channel.messageId, trigger: "IMPORTER_MESSAGE" }),
          refs: { supplierId: contact.supplierId, contactId: contact.contactId },
          detail: { confirmedBy: confirmed.confirmedBy ?? "BROKER" },
        });
        for (const operationId of operationIds) {
          await deps.events.enqueue(
            channelEvent({
              type: "AGENT_TURN",
              eventId: turnEventId("CONTACT_CONFIRMED", input.channel?.wamid ?? `${contact.contactId}#${operationId}`),
              operationId,
              clockId: contact.clockId,
              firmId: contact.firmId,
              eventAtSim: atSim,
              correlationId: ctx.correlationId,
              trigger: "CONTACT_CONFIRMED",
              ...(input.channel === undefined ? {} : { messageId: input.channel.messageId }),
            }),
          );
        }
        return { contact: contactView(confirmed), changed: true, turns: operationIds.length };
      },
    },
    deps,
  );
}
