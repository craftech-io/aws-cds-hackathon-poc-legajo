// Edge of the registry with the BFF (docs/tool-catalog.md, `registry` router). The two lists are
// typed procedures of the `AppRouter`; the changes below go through tRPC's untyped client, each input
// validated before it leaves with the one schema of that procedure (@legajo/shared console-inputs,
// the same the scenarios and the BFF router use; `.strict()`: nothing the procedure does not declare).
// Ids of the firm travel as they came from the lists; the BFF fences every one of them to the user's
// firm, and never takes a firm from the input. The console's firm has one world, so no `clockId`.
import {
  AuthorizationSetInput,
  ConsentRecordInput,
  ConsentRevokeInput,
  ContactConfirmInput,
  ContactUpsertInput,
  ImporterUpsertInput,
  SupplierBehaviourSetInput,
  SupplierUpsertInput,
} from "@legajo/shared";
import { getUntypedClient } from "@trpc/client";
import { z } from "zod";
import type { ConsoleClient } from "../../lib/trpc";
import { CONSENT_TEXT_VERSIONS } from "./copy";

/** The console only offers the consent texts it shows. */
const ConsentRecord = ConsentRecordInput.refine((input) => (CONSENT_TEXT_VERSIONS as readonly string[]).includes(input.textVersion), "unknown consent text version");

const PROCEDURES = {
  upsertImporter: { path: "registry.importers.upsert", schema: ImporterUpsertInput },
  recordConsent: { path: "registry.consent.record", schema: ConsentRecord },
  revokeConsent: { path: "registry.consent.revoke", schema: ConsentRevokeInput },
  setAuthorization: { path: "registry.authorization.set", schema: AuthorizationSetInput },
  upsertSupplier: { path: "registry.suppliers.upsert", schema: SupplierUpsertInput },
  upsertContact: { path: "registry.contacts.upsert", schema: ContactUpsertInput },
  confirmContact: { path: "registry.contacts.confirm", schema: ContactConfirmInput },
  setBehaviour: { path: "registry.supplierBehaviour.set", schema: SupplierBehaviourSetInput },
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
