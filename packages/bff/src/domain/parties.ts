// `Parties` table (docs/architecture.md §5): importers (identity by registered phone), the WhatsApp
// opt-in and the supplier-contact authorizations (both with dated histories), suppliers, their
// contacts (status history; the agent only writes to an ACTIVE one), the measured supplier profile
// and the `ADDR#<hash>` claims that make every phone and email unique in the stage.
import { z } from "zod";
import {
  BrokerId,
  ClockId,
  ConsentMedium,
  ContactId,
  DocType,
  FirmId,
  ImporterId,
  Language,
  MessageId,
  SupplierBehaviour,
  SupplierContactStatus,
  SupplierId,
} from "@legajo/shared";
import { CountryCode, E164, EmailAddress, HexHash, HistoryStamp, IanaZone, NonEmptyText, ZonedInstant, defineEntity, entryAt } from "./common";

export const Importer = defineEntity({
  importerId: ImporterId,
  firmId: FirmId,
  clockId: ClockId,
  /** Company name (fictitious in the seed). */
  name: NonEmptyText,
  contactName: NonEmptyText,
  contactFirstName: NonEmptyText,
  /** The only place the phone is kept in clear; everything else uses `phoneHash`. */
  phoneE164: E164,
  phoneHash: HexHash,
  language: Language.default("es"),
});
export type Importer = z.output<typeof Importer>;

export const ConsentEvent = HistoryStamp.extend({
  action: z.enum(["GRANTED", "REVOKED"]),
  medium: ConsentMedium.optional(),
  textVersion: z.string().min(1).optional(),
});
export type ConsentEvent = z.infer<typeof ConsentEvent>;

/** WhatsApp opt-in of the importer's contact (`CONSENT#WHATSAPP`). */
export const Consent = defineEntity({
  importerId: ImporterId,
  firmId: FirmId,
  clockId: ClockId,
  channel: z.literal("WHATSAPP"),
  /** Current grant: when, how and which version of the text was shown. */
  grantedAt: ZonedInstant,
  medium: ConsentMedium,
  textVersion: NonEmptyText,
  /** Opt-out; absent while the consent is in force. */
  revokedAt: ZonedInstant.optional(),
  revokeReason: z.string().max(200).optional(),
  history: z.array(ConsentEvent).min(1),
});
export type Consent = z.output<typeof Consent>;

/** Whether the opt-in was in force at a simulated instant, rebuilt from its history. */
export function consentActiveAt(consent: Pick<Consent, "history"> | undefined, atSim: string, atReal?: string): boolean {
  return consent !== undefined && entryAt(consent.history, atSim, atReal)?.action === "GRANTED";
}

export const AuthorizationEvent = HistoryStamp.extend({ action: z.enum(["AUTHORIZED", "REVOKED"]) });
export type AuthorizationEvent = z.infer<typeof AuthorizationEvent>;

/** The importer's permission for the agent to write to its supplier (`AUTH#<supplierId>`). */
export const SupplierAuthorization = defineEntity({
  importerId: ImporterId,
  supplierId: SupplierId,
  firmId: FirmId,
  clockId: ClockId,
  authorized: z.boolean(),
  authorizedAt: ZonedInstant.optional(),
  /** Broker who registered the current authorization. */
  brokerId: BrokerId.optional(),
  revokedAt: ZonedInstant.optional(),
  history: z.array(AuthorizationEvent).min(1),
});
export type SupplierAuthorization = z.output<typeof SupplierAuthorization>;

export function authorizationActiveAt(authorization: Pick<SupplierAuthorization, "history"> | undefined, atSim: string, atReal?: string): boolean {
  return authorization !== undefined && entryAt(authorization.history, atSim, atReal)?.action === "AUTHORIZED";
}

/** Parameters of the supplier simulator's behaviour (docs/seed-spec.md §6). */
export const BehaviourParams = z
  .object({
    delayHours: z.number().positive().optional(),
    realReplyAfterHours: z.number().positive().optional(),
    promiseHours: z.number().positive().optional(),
  })
  .strict();
export type BehaviourParams = z.infer<typeof BehaviourParams>;

export const Supplier = defineEntity({
  supplierId: SupplierId,
  firmId: FirmId,
  clockId: ClockId,
  name: NonEmptyText,
  country: CountryCode,
  timezone: IanaZone,
  language: Language.default("en"),
  behaviour: SupplierBehaviour,
  behaviourParams: BehaviourParams.default({}),
});
export type Supplier = z.output<typeof Supplier>;

export const ContactStatusEvent = HistoryStamp.extend({ status: SupplierContactStatus });
export type ContactStatusEvent = z.infer<typeof ContactStatusEvent>;

/** Who confirmed a contact: the importer's button, the console, or the seed. */
export const ContactConfirmer = z.enum(["IMPORTER", "BROKER", "SEED"]);
export type ContactConfirmer = z.infer<typeof ContactConfirmer>;

export const SupplierContact = defineEntity({
  contactId: ContactId,
  supplierId: SupplierId,
  firmId: FirmId,
  clockId: ClockId,
  /** The only place the address is kept in clear. */
  email: EmailAddress,
  emailHash: HexHash,
  status: SupplierContactStatus,
  confirmedBy: ContactConfirmer.optional(),
  confirmedAt: ZonedInstant.optional(),
  /** Message of the importer that carried the address (`propose_supplier_contact`, `LAM-EVIDENCE`). */
  sourceMessageId: MessageId.optional(),
  bouncedAt: ZonedInstant.optional(),
  complainedAt: ZonedInstant.optional(),
  /** Simulated instant of the last `REMINDER` that went out to this contact (FL-028). */
  lastReminderAt: ZonedInstant.optional(),
  statusHistory: z.array(ContactStatusEvent).min(1),
});
export type SupplierContact = z.output<typeof SupplierContact>;

export function contactStatusAt(contact: Pick<SupplierContact, "statusHistory">, atSim: string, atReal?: string): SupplierContactStatus | undefined {
  return entryAt(contact.statusHistory, atSim, atReal)?.status;
}

/** Transitions a contact may take; BOUNCED and COMPLAINED are final (never used again). */
export const CONTACT_TRANSITIONS: Readonly<Record<SupplierContactStatus, readonly SupplierContactStatus[]>> = {
  PENDING_CONFIRMATION: ["ACTIVE", "BOUNCED", "COMPLAINED"],
  ACTIVE: ["BOUNCED", "COMPLAINED"],
  BOUNCED: [],
  COMPLAINED: [],
};

/** Measured, never extracted by a model (docs/design-brief.md §5.4): what `get_counterpart_profile` reads. */
export const SupplierProfile = defineEntity({
  supplierId: SupplierId,
  firmId: FirmId,
  clockId: ClockId,
  medianReplyHours: z.number().nonnegative().optional(),
  lateDocTypes: z.array(DocType).default([]),
  lastBounceAt: ZonedInstant.optional(),
  workingContactId: ContactId.optional(),
  repliesMeasured: z.number().int().nonnegative().default(0),
  bounces: z.number().int().nonnegative().default(0),
});
export type SupplierProfile = z.output<typeof SupplierProfile>;

export const AddressKind = z.enum(["PHONE", "EMAIL", "THREAD"]);
export type AddressKind = z.infer<typeof AddressKind>;

export const ClaimOwnerType = z.enum(["IMPORTER", "SUPPLIER_CONTACT", "OPERATION", "FIRM"]);
export type ClaimOwnerType = z.infer<typeof ClaimOwnerType>;

/**
 * `ADDR#<hash>` / `CLAIM`: its existence is what makes a phone, an email or an operation's thread
 * address unique; written with `attribute_not_exists` in the same transaction as its owner. The hash
 * lives in `addressHash`, never in `phoneHash`/`emailHash`, so a claim never shows up in the identity GSIs.
 */
export const AddressClaim = defineEntity({
  addressHash: HexHash,
  kind: AddressKind,
  ownerType: ClaimOwnerType,
  ownerId: NonEmptyText,
  firmId: FirmId,
  clockId: ClockId.optional(),
});
export type AddressClaim = z.output<typeof AddressClaim>;
