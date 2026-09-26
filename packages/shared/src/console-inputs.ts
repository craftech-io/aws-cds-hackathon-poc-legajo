// Inputs of the console procedures that change a dossier, a conversation, the registry or reset a world
// (docs/tool-catalog.md "Procedimientos de la consola"), defined once for every caller: the console
// (packages/web/src/views/{dossier,registry}), the scenarios through the `QaDriver`
// (scripts/scenarios/lib/console.ts) and the BFF routers that register them. Every input is
// `.strict()`, like every router's; the firm always comes from the token, never from the input.
//
// `clockId` names the world a registry change or a reset acts on: optional for a firm with one world (the BFF
// resolves it), required by the BFF for firm-qa, which owns many (`GLOBAL#firm-qa` and every `qa-*`).
import { z } from "zod";
import { ClockId } from "./clock-ids";
import { IsoInstant } from "./dates";
import { DocType } from "./enums-dossier";
import { ConsentMedium, SupplierBehaviour, WhatsAppTemplateName } from "./enums-messaging";
import { ContactId, DocVersionId, ImporterId, ObservationId, OperationId, SupplierId } from "./ids";

/** The BFF keeps at most this many characters of a reason or a resolution. */
export const CONSOLE_REASON_MAX = 500;
/** Longest free text the firm sends to the importer in one message. */
export const CONSOLE_TEXT_MAX = 1000;

const Reason = z.string().trim().min(1).max(CONSOLE_REASON_MAX);
const Name = z.string().trim().min(1).max(200);
const World = { clockId: ClockId.optional() };

export const E164Phone = z.string().regex(/^\+[1-9]\d{7,14}$/, "expected an E.164 phone");
export const EmailInput = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const CountryCodeInput = z.string().regex(/^[A-Z]{2}$/, "expected an ISO 3166-1 alpha-2 code");

// ---- dossier ------------------------------------------------------------------------------------

export const DossierApproveInput = z.object({ operationId: OperationId }).strict();
export const DossierReopenInput = z.object({ operationId: OperationId, reason: Reason }).strict();
export const WaiveObservationInput = z.object({ operationId: OperationId, observationId: ObservationId, reason: Reason }).strict();
/** An unrecognized version is classified as a type or discarded, always inside its operation. */
export const ClassifyDocumentInput = z.discriminatedUnion("outcome", [
  z.object({ operationId: OperationId, docVersionId: DocVersionId, outcome: z.literal("CLASSIFY"), docType: DocType }).strict(),
  z.object({ operationId: OperationId, docVersionId: DocVersionId, outcome: z.literal("DISCARD") }).strict(),
]);

// ---- conversation ---------------------------------------------------------------------------------

export const ConversationControlInput = z.object({ operationId: OperationId }).strict();
export const ConversationSendInput = z.union([
  z.object({ operationId: OperationId, text: z.string().trim().min(1).max(CONSOLE_TEXT_MAX) }).strict(),
  z.object({ operationId: OperationId, template: WhatsAppTemplateName }).strict(),
]);

// ---- clock ----------------------------------------------------------------------------------------

/** "Reiniciar demo": the user's own world; firm-qa names which of its worlds (SC-20 resets `GLOBAL#firm-qa`). */
export const ClockResetInput = z.object({ ...World }).strict();

// ---- registry -------------------------------------------------------------------------------------

export const ImporterUpsertInput = z
  .object({ ...World, importerId: ImporterId.optional(), name: Name, contactName: Name, contactFirstName: Name, phoneE164: E164Phone.optional(), language: z.literal("es") })
  .strict()
  .refine((input) => input.importerId !== undefined || input.phoneE164 !== undefined, "a new importer needs its phone");
/** When and how the opt-in was given is the firm's record (`grantedAt`), never the server's clock. */
export const ConsentRecordInput = z.object({ ...World, importerId: ImporterId, medium: ConsentMedium, grantedAt: IsoInstant, textVersion: z.string().trim().min(1).max(32) }).strict();
export const ConsentRevokeInput = z.object({ ...World, importerId: ImporterId, reason: z.string().trim().min(1).max(200).optional() }).strict();
export const AuthorizationSetInput = z.object({ ...World, importerId: ImporterId, supplierId: SupplierId, authorized: z.boolean() }).strict();
export const SupplierUpsertInput = z
  .object({ ...World, supplierId: SupplierId.optional(), name: Name, country: CountryCodeInput, timezone: z.string().min(3).max(64), language: z.literal("en"), contacts: z.array(EmailInput).max(5).optional() })
  .strict();
export const ContactUpsertInput = z.object({ ...World, supplierId: SupplierId, email: EmailInput }).strict();
export const ContactConfirmInput = z.object({ ...World, contactId: ContactId }).strict();
export const SupplierBehaviourSetInput = z.object({ ...World, supplierId: SupplierId, behaviour: SupplierBehaviour, operationId: OperationId.optional() }).strict();

/** Every procedure above by its path, the one table callers that go by name validate against. */
export const CONSOLE_CHANGE_INPUTS = {
  "dossier.approve": DossierApproveInput,
  "dossier.reopen": DossierReopenInput,
  "dossier.waiveObservation": WaiveObservationInput,
  "dossier.classifyDocument": ClassifyDocumentInput,
  "conversation.take": ConversationControlInput,
  "conversation.release": ConversationControlInput,
  "conversation.send": ConversationSendInput,
  "clock.reset": ClockResetInput,
  "registry.importers.upsert": ImporterUpsertInput,
  "registry.consent.record": ConsentRecordInput,
  "registry.consent.revoke": ConsentRevokeInput,
  "registry.authorization.set": AuthorizationSetInput,
  "registry.suppliers.upsert": SupplierUpsertInput,
  "registry.contacts.upsert": ContactUpsertInput,
  "registry.contacts.confirm": ContactConfirmInput,
  "registry.supplierBehaviour.set": SupplierBehaviourSetInput,
} as const;

export type ConsoleChangePath = keyof typeof CONSOLE_CHANGE_INPUTS;
export type ConsoleChangeInputs = { readonly [P in ConsoleChangePath]: z.input<(typeof CONSOLE_CHANGE_INPUTS)[P]> };

export function isConsoleChangePath(path: string): path is ConsoleChangePath {
  return Object.hasOwn(CONSOLE_CHANGE_INPUTS, path);
}
