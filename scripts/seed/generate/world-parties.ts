// The registry of a world (docs/seed-spec.md §5-§6): importers with their WhatsApp opt-in and their
// authorizations to write to each supplier (dated histories that `PolicyAudit` rebuilds), suppliers
// with their simulated behaviour, their one registered contact (confirmed when it was registered and
// again by the importer where a story says so) and the profile measured from past replies.
import { CURRENT_CONSENT_TEXT_VERSION } from "@legajo/bff/copy/consent";
import { templateItem, type SeedItem } from "../lib/items";
import type { GoodsKind, SupplierSpec } from "./catalog-parties";
import { rngFor } from "./rng";
import type { WorldContext } from "./world-context";

/** When the firm registered its suppliers' contacts (before every operation of the seed). */
export const CONTACTS_REGISTERED_AT = "2026-09-22T11:00:00-03:00";
const IMPORTER_REGISTERED_AT = "2026-09-29T11:00:00-03:00";

/** Documents some industries usually send late (the profile's `lateDocTypes`). */
const LATE_DOCS: Partial<Record<GoodsKind, readonly string[]>> = { CHEMICALS: ["CERTIFICATE_OF_ORIGIN"], FOOD: ["CERTIFICATE_OF_ORIGIN"], FURNITURE: ["PACKING_LIST"] };

/** Replies measured before the demo, in hours: what `get_counterpart_profile` summarizes (median). */
function pastReplyHours(supplier: SupplierSpec): number[] {
  const rng = rngFor(`profile:${supplier.code}`);
  const sample = (min: number, max: number) => Array.from({ length: 6 }, () => rng.int(min * 10, max * 10) / 10);
  switch (supplier.behaviour) {
    case "NEVER":
    case "BOUNCE":
    case "COMPLAINT":
      return [];
    case "LATE":
      return sample(24, 36);
    case "PROMISE":
      return sample(18, 30);
    case "AUTO_REPLY":
      return sample(2, 4);
    default:
      return sample(0.2, 3);
  }
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.round(value * 10) / 10;
}

function firstName(fullName: string): string {
  return fullName.split(" ")[0] ?? fullName;
}

export function partyItems(world: WorldContext, confirmations: ReadonlyMap<string, string>): SeedItem[] {
  const { firm, clockId } = world;
  const items: SeedItem[] = [];
  for (const importer of world.importers) {
    const { spec } = importer;
    items.push(templateItem("Importer", { importerId: importer.importerId, firmId: firm.firmId, clockId, name: spec.name, contactName: spec.contactName, contactFirstName: firstName(spec.contactName), phoneE164: importer.phoneE164, language: "es" }));
    if (spec.consent !== undefined) {
      items.push(
        templateItem("Consent", {
          importerId: importer.importerId,
          firmId: firm.firmId,
          clockId,
          channel: "WHATSAPP",
          grantedAt: spec.consent.grantedAt,
          medium: spec.consent.medium,
          textVersion: CURRENT_CONSENT_TEXT_VERSION,
          history: [{ atSim: spec.consent.grantedAt, by: "SEED", action: "GRANTED", medium: spec.consent.medium, textVersion: CURRENT_CONSENT_TEXT_VERSION }],
        }),
      );
    }
  }
  for (const { importerId, supplierId } of world.authorizations) {
    const importer = world.importers.find((candidate) => candidate.importerId === importerId);
    const at = importer?.spec.consent?.grantedAt ?? IMPORTER_REGISTERED_AT;
    items.push(templateItem("SupplierAuthorization", { importerId, supplierId, firmId: firm.firmId, clockId, authorized: true, authorizedAt: at, brokerId: world.analystId, history: [{ atSim: at, by: `BROKER:${world.analystId}`, action: "AUTHORIZED" }] }));
  }
  for (const supplier of world.suppliers) {
    const { spec } = supplier;
    items.push(templateItem("Supplier", { supplierId: supplier.supplierId, firmId: firm.firmId, clockId, name: spec.name, country: spec.country, timezone: spec.timezone, language: "en", behaviour: spec.behaviour, behaviourParams: spec.params ?? {} }));
    const confirmedAt = confirmations.get(supplier.contactId);
    items.push(
      templateItem("SupplierContact", {
        contactId: supplier.contactId,
        supplierId: supplier.supplierId,
        firmId: firm.firmId,
        clockId,
        email: supplier.contactEmail,
        status: "ACTIVE",
        confirmedBy: confirmedAt === undefined ? "SEED" : "IMPORTER",
        confirmedAt: confirmedAt ?? CONTACTS_REGISTERED_AT,
        statusHistory: [
          { atSim: CONTACTS_REGISTERED_AT, by: "SEED", status: "ACTIVE", reason: "registered by the firm" },
          ...(confirmedAt === undefined ? [] : [{ atSim: confirmedAt, by: "IMPORTER", status: "ACTIVE", reason: "confirmed by the importer" }]),
        ],
      }),
    );
    const replies = pastReplyHours(spec);
    const medianHours = median(replies);
    items.push(
      templateItem("SupplierProfile", {
        supplierId: supplier.supplierId,
        firmId: firm.firmId,
        clockId,
        ...(medianHours === undefined ? {} : { medianReplyHours: medianHours }),
        lateDocTypes: LATE_DOCS[spec.goods] ?? [],
        ...(replies.length === 0 ? {} : { workingContactId: supplier.contactId }),
        repliesMeasured: replies.length,
        bounces: 0,
      }),
    );
  }
  return items;
}
