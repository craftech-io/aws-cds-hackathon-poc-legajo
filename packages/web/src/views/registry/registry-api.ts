// Edge of the registry with the BFF (docs/tool-catalog.md, `registry` router). The two lists and the
// changes below are typed procedures of the `AppRouter`; each change is validated before it leaves with
// the one schema of that procedure (@legajo/shared console-inputs,
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

/** A validated change with the procedure it goes to, typed against the `AppRouter`. */
export type RegistryRequest = { readonly [K in keyof Procedures]: { readonly kind: K; readonly path: Procedures[K]["path"]; readonly input: z.output<Procedures[K]["schema"]> } }[keyof Procedures];

/** Procedure and validated input of a change; a malformed input throws before anything is sent. */
export function changeRequest(change: RegistryChange): RegistryRequest {
  switch (change.kind) {
    case "upsertImporter":
      return { kind: change.kind, path: PROCEDURES.upsertImporter.path, input: PROCEDURES.upsertImporter.schema.parse(change.input) };
    case "recordConsent":
      return { kind: change.kind, path: PROCEDURES.recordConsent.path, input: PROCEDURES.recordConsent.schema.parse(change.input) };
    case "revokeConsent":
      return { kind: change.kind, path: PROCEDURES.revokeConsent.path, input: PROCEDURES.revokeConsent.schema.parse(change.input) };
    case "setAuthorization":
      return { kind: change.kind, path: PROCEDURES.setAuthorization.path, input: PROCEDURES.setAuthorization.schema.parse(change.input) };
    case "upsertSupplier":
      return { kind: change.kind, path: PROCEDURES.upsertSupplier.path, input: PROCEDURES.upsertSupplier.schema.parse(change.input) };
    case "upsertContact":
      return { kind: change.kind, path: PROCEDURES.upsertContact.path, input: PROCEDURES.upsertContact.schema.parse(change.input) };
    case "confirmContact":
      return { kind: change.kind, path: PROCEDURES.confirmContact.path, input: PROCEDURES.confirmContact.schema.parse(change.input) };
    case "setBehaviour":
      return { kind: change.kind, path: PROCEDURES.setBehaviour.path, input: PROCEDURES.setBehaviour.schema.parse(change.input) };
  }
}

export function runRegistryChange(trpc: ConsoleClient, change: RegistryChange): Promise<unknown> {
  const request = changeRequest(change);
  switch (request.kind) {
    case "upsertImporter":
      return trpc.registry.importers.upsert.mutate(request.input);
    case "recordConsent":
      return trpc.registry.consent.record.mutate(request.input);
    case "revokeConsent":
      return trpc.registry.consent.revoke.mutate(request.input);
    case "setAuthorization":
      return trpc.registry.authorization.set.mutate(request.input);
    case "upsertSupplier":
      return trpc.registry.suppliers.upsert.mutate(request.input);
    case "upsertContact":
      return trpc.registry.contacts.upsert.mutate(request.input);
    case "confirmContact":
      return trpc.registry.contacts.confirm.mutate(request.input);
    case "setBehaviour":
      return trpc.registry.supplierBehaviour.set.mutate(request.input);
  }
}
