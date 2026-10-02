// What a deferred send keeps in its `TIMER#DEFERRED_SEND#<messageId>` (docs/architecture.md §8): the
// request as the caller made it (minus the instant and the id, which the firing gives again), what the
// text was allowed to carry when it was checked (the turn's results live one hour; the timer may fire
// days later) and the upload link its template's button already carries. Read back with zod: a payload
// that does not parse is never sent.
import { z } from "zod";
import { DocType, MessageKind, ObservationId, SupplierEmailKind, TurnTrigger, WaButtonAction, WhatsAppTemplateName } from "@legajo/shared";
import { ContactNoncePayload } from "../channels/whatsapp/nonces";
import { Actor } from "../domain/common";
import type { LinkAllowance } from "./links";
import type { OutboundRequest } from "./types";

const Refs = z.strictObject({ docTypes: z.array(DocType).optional(), observationIds: z.array(ObservationId).optional() });

const Base = {
  operationId: z.string().min(1).max(64),
  kind: MessageKind,
  author: Actor,
  textSource: z.enum(["MODEL", "CODE", "PERSON"]),
  trigger: TurnTrigger.optional(),
  turnId: z.string().min(1).max(64).optional(),
  answers: z.string().min(1).max(128).optional(),
  refs: Refs.optional(),
};

const StoredWhatsApp = z.strictObject({
  ...Base,
  channel: z.literal("WHATSAPP"),
  text: z.string().max(4096).optional(),
  template: z.strictObject({ name: WhatsAppTemplateName, params: z.array(z.string().max(1024)).max(10) }).optional(),
  buttons: z.array(z.strictObject({ action: WaButtonAction, payload: ContactNoncePayload.optional() })).max(10).optional(),
});

const StoredSupplierEmail = z.strictObject({
  ...Base,
  channel: z.literal("EMAIL"),
  counterpart: z.literal("SUPPLIER"),
  kind: SupplierEmailKind,
  contactId: z.string().min(1).max(64).optional(),
  text: z.string().max(20_000),
});

const StoredFirmEmail = z.strictObject({
  ...Base,
  channel: z.literal("EMAIL"),
  counterpart: z.literal("FIRM"),
  subject: z.string().max(998),
  text: z.string().max(20_000),
});

export const StoredRequest = z.union([StoredWhatsApp, StoredSupplierEmail, StoredFirmEmail]);

export const DeferredPayload = z.strictObject({
  request: StoredRequest,
  allowance: z.strictObject({ links: z.array(z.string().max(2048)).max(20), numbers: z.array(z.string().max(32)).max(200) }),
  uploadToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
});
export type DeferredPayload = z.infer<typeof DeferredPayload>;

/** The request without what the firing gives again (the decided instant and the message id). */
export type StoredOutbound = Omit<OutboundRequest, "eventAtSim" | "messageId">;

function stripped(request: OutboundRequest): StoredOutbound {
  const { eventAtSim: _at, messageId: _id, ...rest } = request;
  return rest;
}

/** What a deferred send's timer carries; `parse` makes sure it reads back. */
export function deferredPayloadOf(request: OutboundRequest, allowance: Pick<LinkAllowance, "links"> & { readonly numbers: Iterable<string> }, uploadToken?: string): DeferredPayload {
  return DeferredPayload.parse({
    request: JSON.parse(JSON.stringify(stripped(request))) as unknown,
    allowance: { links: [...allowance.links], numbers: [...allowance.numbers] },
    ...(uploadToken === undefined ? {} : { uploadToken }),
  });
}

/** The request of a deferred send at the instant it fires, or `undefined` for a payload that does not parse. */
export function requestOf(payload: unknown, at: { readonly eventAtSim: string; readonly messageId: string }): { readonly request: OutboundRequest; readonly payload: DeferredPayload } | undefined {
  const parsed = DeferredPayload.safeParse(payload);
  if (!parsed.success) return undefined;
  return { request: { ...(parsed.data.request as StoredOutbound), ...at } as OutboundRequest, payload: parsed.data };
}
