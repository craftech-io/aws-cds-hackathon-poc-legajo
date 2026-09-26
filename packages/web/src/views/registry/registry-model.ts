// Pure rules of the registry (FL-001, FL-003, FL-004, FL-006, FL-088): how the opt-in and the
// authorizations of an importer read, which suppliers an importer works with, what the forms send
// (validated with the same shared schemas as registry-api.ts) and the refusal texts of the fence and of a
// duplicated phone or email. No React here: registry-model.test.ts covers it.
import { CountryCodeInput, DocType, E164Phone, EmailInput } from "@legajo/shared";
import { z } from "zod";
import { dataCopy } from "../../copy/console-data";
import type { ApiError } from "../../lib/api-error";
import { formatNumber, formatSimDateTime } from "../../lib/format";
import type { RouterOutputs } from "../../lib/trpc-router";
import { DOC_TYPE_LABELS, MEDIUM_LABELS, registryCopy } from "./copy";

export type ImporterRow = RouterOutputs["registry"]["importers"]["list"]["importers"][number];
export type SupplierRow = RouterOutputs["registry"]["suppliers"]["list"]["suppliers"][number];
export type ContactRow = SupplierRow["contacts"][number];

export type ConsentTone = "success" | "warning" | "neutral";

/** "Vigente desde mar 30/09 12:00 · Formulario firmado · texto v1", "Revocado el …" or "Sin opt-in". */
export function consentSummary(consent: ImporterRow["consent"]): { readonly text: string; readonly tone: ConsentTone } {
  const copy = registryCopy.consent;
  switch (consent.status) {
    case "GRANTED":
      return { text: copy.granted(formatSimDateTime(consent.grantedAt), MEDIUM_LABELS[consent.medium], consent.textVersion), tone: "success" };
    case "REVOKED":
      return { text: copy.revoked(formatSimDateTime(consent.revokedAt)), tone: "warning" };
    case "NONE":
      return { text: copy.none, tone: "neutral" };
  }
}

export interface AuthorizationView {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly authorized: boolean;
  readonly since: string | undefined;
}

/** One row per supplier of the firm: whether this importer authorized the agent to write to it. */
export function authorizationViews(importer: Pick<ImporterRow, "authorizations">, suppliers: readonly Pick<SupplierRow, "supplierId" | "name">[]): AuthorizationView[] {
  return suppliers.map((supplier) => {
    const current = importer.authorizations.find((authorization) => authorization.supplierId === supplier.supplierId);
    return {
      supplierId: supplier.supplierId,
      supplierName: supplier.name,
      authorized: current?.authorized === true,
      since: current?.authorized && current.authorizedAt ? formatSimDateTime(current.authorizedAt) : undefined,
    };
  });
}

/** Names of the suppliers the importer authorized, for the table. */
export function authorizedNames(importer: Pick<ImporterRow, "authorizations">, suppliers: readonly Pick<SupplierRow, "supplierId" | "name">[]): string[] {
  return authorizationViews(importer, suppliers)
    .filter((view) => view.authorized)
    .map((view) => view.supplierName);
}

/** The measured supplier profile (`SupplierProfile`), when the list carries one: measurements, never a model's guess. */
const MeasuredProfile = z.looseObject({
  profile: z
    .looseObject({
      medianReplyHours: z.number().nonnegative().nullish(),
      repliesMeasured: z.number().int().nonnegative().nullish(),
      bounces: z.number().int().nonnegative().nullish(),
      lateDocTypes: z.array(DocType).nullish(),
    })
    .nullish(),
});

/** "Responde en ~6 h (4 respuestas) · 1 rebote · Suele demorar: certificado de origen", or nothing measured yet. */
export function profileLines(supplier: unknown): string[] {
  const parsed = MeasuredProfile.safeParse(supplier);
  const profile = parsed.success ? parsed.data.profile : undefined;
  if (!profile) return [];
  const copy = registryCopy.suppliers;
  const lines: string[] = [];
  if (profile.medianReplyHours != null && (profile.repliesMeasured ?? 0) > 0) lines.push(copy.replies(formatNumber(profile.medianReplyHours, 1), profile.repliesMeasured ?? 0));
  if ((profile.bounces ?? 0) > 0) lines.push(copy.bounces(profile.bounces ?? 0));
  if (profile.lateDocTypes && profile.lateDocTypes.length > 0) lines.push(copy.late(profile.lateDocTypes.map((docType) => DOC_TYPE_LABELS[docType]).join(", ")));
  return lines;
}

/** A refusal of a registry change in the firm's words: the fence and a duplicate get their own text. */
export function registryErrorText(error: ApiError): string {
  const own = error.reason !== null ? (registryCopy.reasons[error.reason] ?? dataCopy.byReason[error.reason]) : undefined;
  if (own) return own;
  if (error.kind === "conflict") return registryCopy.reasons.CONFLICT ?? dataCopy.byKind.conflict;
  return dataCopy.byKind[error.kind];
}

export function isE164(value: string): boolean {
  return E164Phone.safeParse(value.trim()).success;
}

export function isCountryCode(value: string): boolean {
  return CountryCodeInput.safeParse(value.trim()).success;
}

/** Whether the zone exists (IANA name the runtime knows). */
export function isTimeZone(value: string): boolean {
  const zone = value.trim();
  if (zone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The contacts textarea: one address per line, blanks ignored, duplicates once; `undefined` when one is invalid. */
export function parseContactLines(text: string): string[] | undefined {
  const lines = [...new Set(text.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter((line) => line !== ""))];
  const parsed = lines.map((line) => EmailInput.safeParse(line));
  return parsed.every((result) => result.success) ? lines : undefined;
}

export interface OperationScope {
  readonly operationId: string;
  readonly operationNumber: string;
  readonly supplierId: string;
}

/** Operations of a supplier, for "Solo la operación …" of the behaviour form. */
export function operationsOf(supplierId: string, operations: readonly OperationScope[]): OperationScope[] {
  return operations.filter((operation) => operation.supplierId === supplierId).sort((a, b) => a.operationNumber.localeCompare(b.operationNumber));
}
