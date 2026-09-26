// Edge of the registry with the BFF (docs/tool-catalog.md, `registry` router). The two lists are
// typed procedures of the `AppRouter`; the changes below go through tRPC's untyped client, each input
// validated with zod before it leaves (`.strict()`: nothing the procedure does not declare), like the
// shell's calls in lib/console-api.ts. Ids of the firm travel as they came from the lists; the BFF
// fences every one of them to the user's firm, and never takes a firm from the input.
//
//   registry.importers.upsert       { importerId?, name, contactName, contactFirstName, phoneE164?, language }
//   registry.consent.record         { importerId, medium, grantedAt, textVersion }
//   registry.consent.revoke         { importerId, reason? }
//   registry.authorization.set      { importerId, supplierId, authorized }
//   registry.suppliers.upsert       { supplierId?, name, country, timezone, language, contacts? }
//   registry.contacts.upsert        { supplierId, email }
//   registry.contacts.confirm       { contactId }
//   registry.supplierBehaviour.set  { supplierId, behaviour, operationId? }
import { ConsentMedium, ContactId, ImporterId, IsoInstant, OperationId, SupplierBehaviour, SupplierId } from "@legajo/shared";
import { getUntypedClient } from "@trpc/client";
import { z } from "zod";
import type { ConsoleClient } from "../../lib/trpc";
import { CONSENT_TEXT_VERSIONS } from "./copy";

const Text = z.string().trim().min(1).max(200);
export const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "expected an E.164 phone");
export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, "expected an ISO 3166-1 alpha-2 code");

export const ImporterUpsert = z
  .object({ importerId: ImporterId.optional(), name: Text, contactName: Text, contactFirstName: Text, phoneE164: E164.optional(), language: z.literal("es") })
  .strict()
  .refine((input) => input.importerId !== undefined || input.phoneE164 !== undefined, "a new importer needs its phone");

export const ConsentRecord = z.object({ importerId: ImporterId, medium: ConsentMedium, grantedAt: IsoInstant, textVersion: z.enum(CONSENT_TEXT_VERSIONS) }).strict();
export const ConsentRevoke = z.object({ importerId: ImporterId, reason: z.string().trim().min(1).max(200).optional() }).strict();
export const AuthorizationSet = z.object({ importerId: ImporterId, supplierId: SupplierId, authorized: z.boolean() }).strict();
export const SupplierUpsert = z
  .object({ supplierId: SupplierId.optional(), name: Text, country: CountryCode, timezone: z.string().min(3).max(64), language: z.literal("en"), contacts: z.array(Email).max(5).optional() })
  .strict();
export const ContactUpsert = z.object({ supplierId: SupplierId, email: Email }).strict();
export const ContactConfirm = z.object({ contactId: ContactId }).strict();
export const BehaviourSet = z.object({ supplierId: SupplierId, behaviour: SupplierBehaviour, operationId: OperationId.optional() }).strict();

const PROCEDURES = {
  upsertImporter: { path: "registry.importers.upsert", schema: ImporterUpsert },
  recordConsent: { path: "registry.consent.record", schema: ConsentRecord },
  revokeConsent: { path: "registry.consent.revoke", schema: ConsentRevoke },
  setAuthorization: { path: "registry.authorization.set", schema: AuthorizationSet },
  upsertSupplier: { path: "registry.suppliers.upsert", schema: SupplierUpsert },
  upsertContact: { path: "registry.contacts.upsert", schema: ContactUpsert },
  confirmContact: { path: "registry.contacts.confirm", schema: ContactConfirm },
  setBehaviour: { path: "registry.supplierBehaviour.set", schema: BehaviourSet },
} as const;

type Procedures = typeof PROCEDURES;
export type RegistryChange = { readonly [K in keyof Procedures]: { readonly kind: K; readonly input: z.input<Procedures[K]["schema"]> } }[keyof Procedures];

/** Procedure and validated input of a change; a malformed input throws before anything is sent. */
export function changeRequest(change: RegistryChange): { readonly path: string; readonly input: unknown } {
  const procedure = PROCEDURES[change.kind];
  return { path: procedure.path, input: procedure.schema.parse(change.input) };
}

export async function runRegistryChange(trpc: ConsoleClient, change: RegistryChange): Promise<unknown> {
  const { path, input } = changeRequest(change);
  return getUntypedClient(trpc).mutation(path, input);
}
