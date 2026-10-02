// The importer side of `upsert_party` (docs/tool-catalog.md, FL-001): a new importer of the caller's
// world with its phone claimed in the same transaction (`ADDR#<phoneHash>`: one phone, one contact in the
// whole stage; a phone in use is `CONFLICT` and writes nothing), or an edit of one of the firm's
// importers (a new phone moves the claim in the same transaction). The phone is kept in clear only on
// the importer row; the identity index and the claim hold its keyed hash.
import { type ImporterUpsertInput, ToolError, maskPhone } from "@legajo/shared";
import type { z } from "zod";
import type { ImporterPatch } from "../../connector/ports";
import type { Importer } from "../../domain/parties";
import type { DirectContext } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";
import { registryWorld } from "../operations-admin/world-scope";
import { checkPartyPhone } from "./address-rules";

type ImporterData = z.output<typeof ImporterUpsertInput>;

export function importerView(importer: Importer) {
  return { importerId: importer.importerId, clockId: importer.clockId, name: importer.name, contactName: importer.contactName, phoneMasked: maskPhone(importer.phoneE164), language: importer.language };
}

/** The phone's keyed hash, refused when another party of the stage already holds it. */
async function claimablePhone(deps: ServiceDeps, phone: string, clockId: string, ownerId?: string): Promise<string> {
  checkPartyPhone(phone, clockId);
  const hash = deps.keys.phoneHash(phone);
  const claim = await deps.connector.parties.getAddressClaim(hash);
  if (claim !== undefined && claim.ownerId !== ownerId) throw new ToolError("CONFLICT", "that phone already belongs to another contact or firm", "CONFLICT");
  return hash;
}

export async function upsertImporter(ctx: DirectContext<unknown>, deps: ServiceDeps, firmId: string, data: ImporterData) {
  const { parties } = ctx.connector;
  if (data.importerId === undefined) {
    const clockId = await registryWorld(ctx, firmId, data.clockId);
    if (data.phoneE164 === undefined) throw new ToolError("INVALID", "a new importer needs its phone", "PHONE_REQUIRED");
    const phoneHash = await claimablePhone(deps, data.phoneE164, clockId);
    const importer = await parties.createImporter({
      importerId: `imp-${deps.newId().toLowerCase()}`,
      firmId,
      clockId,
      name: data.name,
      contactName: data.contactName,
      contactFirstName: data.contactFirstName,
      phoneE164: data.phoneE164,
      phoneHash,
      language: data.language,
    });
    return { importer, created: true };
  }
  const current = await parties.getImporter(data.importerId);
  await ctx.fence(current.firmId, { kind: "importer", id: current.importerId });
  if (data.clockId !== undefined && data.clockId !== current.clockId) throw new ToolError("INVALID", "the importer is not of the world named", "WORLD_MISMATCH");
  const patch: ImporterPatch = { name: data.name, contactName: data.contactName, contactFirstName: data.contactFirstName, language: data.language };
  const phoneChanged = data.phoneE164 !== undefined && data.phoneE164 !== current.phoneE164;
  const phonePatch = phoneChanged && data.phoneE164 !== undefined ? { phoneE164: data.phoneE164, phoneHash: await claimablePhone(deps, data.phoneE164, current.clockId, current.importerId) } : {};
  const importer = await parties.updateImporter(current.importerId, { ...patch, ...phonePatch }, current.version);
  return { importer, created: false };
}
