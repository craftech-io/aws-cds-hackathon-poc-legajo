// Button nonces (docs/tool-catalog.md `send_whatsapp`, docs/architecture.md §13 "Varias operaciones
// abiertas"): every button a message carries is an opaque nonce (`Runtime/NONCE#`, 7 days) bound to the
// importer's phone hash, the importer, the operation and the message that carried it. The model and the
// importer only ever see the nonce; what it means lives here. A nonce is derived from the message id,
// its position and the `nonce` subkey, so a retried send writes the same ones and nobody can guess one.
//
// Resolution refuses (and the caller audits `DENY NONCE_*`, then reads the button title as free text):
//   NONCE_UNKNOWN          no such nonce (never issued, or already gone)
//   NONCE_EXPIRED          past its 7 days
//   NONCE_FOREIGN          issued to another phone, importer or world
//   NONCE_OTHER_OPERATION  not a nonce of the message the importer is replying to, or of an operation
//                          that is not the importer's
//   NONCE_USED             a one-shot action already taken (a contact decision; a choice of operation,
//                          which uses up every row of its list)
import { z } from "zod";
import { ConnectorError, ContactId, MessageId, OperationId, SupplierId, WaButtonAction } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import { RUNTIME_TTL_SECONDS, type Nonce } from "../../domain/runtime";
import { epochSecondsAfter, isExpired } from "../../domain/common";
import { type SecretKey, hmacSha256Base64Url } from "../../lib/crypto";
import { AcceptedMedia } from "./media";

export const NONCE_REFUSALS = ["NONCE_UNKNOWN", "NONCE_EXPIRED", "NONCE_FOREIGN", "NONCE_OTHER_OPERATION", "NONCE_USED"] as const;
export type NonceRefusal = (typeof NONCE_REFUSALS)[number];

/** Actions whose effect happens once: a second tap is refused instead of repeating it. */
export const ONE_SHOT_ACTIONS: ReadonlySet<WaButtonAction> = new Set<WaButtonAction>(["CONFIRM_CONTACT", "REJECT_CONTACT", "CHOOSE_OPERATION"]);

/** `CONFIRM_CONTACT` / `REJECT_CONTACT`: the contact the importer is asked about. */
export const ContactNoncePayload = z.strictObject({ supplierId: SupplierId, contactId: ContactId });
export type ContactNoncePayload = z.infer<typeof ContactNoncePayload>;

/** `CHOOSE_OPERATION`: the unrouted message the choice sends to the operation of the row. */
export const ChoiceNoncePayload = z.strictObject({
  sourceOperationId: OperationId,
  sourceMessageId: MessageId,
  sourceWamid: z.string().min(1).max(256),
  /** The message had text for a turn (not only a PDF). */
  hasText: z.boolean(),
  /** PDFs of the message, waiting for the choice to know their operation's intake. */
  media: z.array(AcceptedMedia).max(10).default([]),
});
export type ChoiceNoncePayload = z.infer<typeof ChoiceNoncePayload>;

export interface ButtonToIssue {
  readonly action: WaButtonAction;
  /** A row of an `OPERATION_CHOICE` stands for the operation it offers; every other button for the message's operation. */
  readonly operationId?: string;
  readonly payload?: ContactNoncePayload | ChoiceNoncePayload;
}

export interface IssueNoncesInput {
  /** Subkey `nonce` (lib/secrets.ts `subkey`). */
  readonly nonceKey: SecretKey;
  /** The message that carries the buttons. */
  readonly messageId: string;
  readonly operationId: string;
  readonly importerId: string;
  readonly phoneHash: string;
  readonly clockId: string;
  readonly buttons: readonly ButtonToIssue[];
  /** Real time: a nonce lives 7 real days. */
  readonly now: Date;
}

/** The nonce of the button at `index` of `messageId` (32 base64url characters). */
export function deriveNonce(nonceKey: SecretKey, messageId: string, index: number, action: WaButtonAction): string {
  return hmacSha256Base64Url(nonceKey, `${messageId}#${index}#${action}`).slice(0, 32);
}

function payloadSchema(action: WaButtonAction): z.ZodType | undefined {
  if (action === "CONFIRM_CONTACT" || action === "REJECT_CONTACT") return ContactNoncePayload;
  if (action === "CHOOSE_OPERATION") return ChoiceNoncePayload;
  return undefined;
}

/**
 * Writes one nonce per button and answers them in order. Idempotent: the same message issues the same
 * nonces, and a nonce already written with the same binding is kept.
 */
export async function issueNonces(runtime: Connector["runtime"], input: IssueNoncesInput): Promise<string[]> {
  const nonces: string[] = [];
  for (const [index, button] of input.buttons.entries()) {
    const schema = payloadSchema(button.action);
    if (schema !== undefined && schema.safeParse(button.payload).success === false) throw new RangeError(`a ${button.action} button needs its payload`);
    const nonce = deriveNonce(input.nonceKey, input.messageId, index, button.action);
    const operationId = button.operationId ?? input.operationId;
    try {
      await runtime.putNonce({
        nonce,
        action: button.action,
        operationId,
        importerId: input.importerId,
        phoneHash: input.phoneHash,
        clockId: input.clockId,
        messageId: input.messageId,
        payload: { ...(button.payload ?? {}) },
        expiresAt: epochSecondsAfter(input.now, RUNTIME_TTL_SECONDS.nonce),
      });
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
      const existing = await runtime.getNonce(nonce);
      if (existing?.operationId !== operationId || existing.phoneHash !== input.phoneHash || existing.action !== button.action) throw error;
    }
    nonces.push(nonce);
  }
  return nonces;
}

export interface ResolveNonceInput {
  readonly value: string;
  readonly importer: { readonly importerId: string; readonly clockId: string };
  readonly phoneHash: string;
  /** `context.id` of the reply: the `wamid` of our message the importer tapped. */
  readonly contextWamid?: string;
  readonly now: Date;
}

export type NonceResolution = { readonly ok: true; readonly nonce: Nonce } | { readonly ok: false; readonly reason: NonceRefusal; readonly nonce?: Nonce };

const refuse = (reason: NonceRefusal, nonce?: Nonce): NonceResolution => (nonce === undefined ? { ok: false, reason } : { ok: false, reason, nonce });

/** What a tapped button means, or why it means nothing. Never consumes the nonce (see `consumeNonce`). */
export async function resolveNonce(data: Pick<Connector, "runtime" | "conversations" | "operations">, input: ResolveNonceInput): Promise<NonceResolution> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.value)) return refuse("NONCE_UNKNOWN");
  const nonce = await data.runtime.getNonce(input.value);
  if (nonce === undefined) return refuse("NONCE_UNKNOWN");
  if (isExpired(nonce.expiresAt, input.now)) return refuse("NONCE_EXPIRED", nonce);
  if (nonce.phoneHash !== input.phoneHash || nonce.importerId !== input.importer.importerId || nonce.clockId !== input.importer.clockId) return refuse("NONCE_FOREIGN", nonce);
  if (input.contextWamid !== undefined) {
    const replied = await data.conversations.findMessageByProviderId(input.contextWamid);
    if (replied === undefined || (nonce.messageId !== undefined && replied.messageId !== nonce.messageId)) return refuse("NONCE_OTHER_OPERATION", nonce);
  }
  const operation = await data.operations.findOperation(nonce.operationId);
  if (operation === undefined || operation.importerId !== input.importer.importerId || operation.clockId !== input.importer.clockId) return refuse("NONCE_OTHER_OPERATION", nonce);
  if (ONE_SHOT_ACTIONS.has(nonce.action) && nonce.usedAtReal !== undefined) return refuse("NONCE_USED", nonce);
  return { ok: true, nonce };
}

/** Rows of an `OPERATION_CHOICE` list, at most (Meta's limit of an interactive list). */
export const MAX_CHOICE_ROWS = 10;

async function markUsed(runtime: Connector["runtime"], value: string, now: Date): Promise<void> {
  try {
    await runtime.useNonce(value, now.toISOString());
  } catch (error) {
    // Already used (a concurrent tap), or never issued (a list shorter than the maximum).
    if (!(error instanceof ConnectorError && (error.code === "CONFLICT" || error.code === "NOT_FOUND"))) throw error;
  }
}

/**
 * Marks a one-shot nonce used once its effect is done. A choice of operation uses up its whole list:
 * the message goes to one operation only, so another row tapped later is refused (`NONCE_USED`).
 */
export async function consumeNonce(runtime: Connector["runtime"], nonceKey: SecretKey, nonce: Nonce, now: Date): Promise<void> {
  if (!ONE_SHOT_ACTIONS.has(nonce.action)) return;
  if (nonce.action !== "CHOOSE_OPERATION" || nonce.messageId === undefined) return markUsed(runtime, nonce.nonce, now);
  for (let index = 0; index < MAX_CHOICE_ROWS; index += 1) {
    const row = deriveNonce(nonceKey, nonce.messageId, index, "CHOOSE_OPERATION");
    if (row === nonce.nonce || (await runtime.getNonce(row)) !== undefined) await markUsed(runtime, row, now);
  }
}

export function contactPayloadOf(nonce: Nonce): ContactNoncePayload | undefined {
  const parsed = ContactNoncePayload.safeParse(nonce.payload);
  return parsed.success ? parsed.data : undefined;
}

export function choicePayloadOf(nonce: Nonce): ChoiceNoncePayload | undefined {
  const parsed = ChoiceNoncePayload.safeParse(nonce.payload);
  return parsed.success ? parsed.data : undefined;
}
