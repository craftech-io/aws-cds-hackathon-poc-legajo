// Assembles each world of the seed from its context: firm rows, registry, operations with their
// stories, and (for `qa-min`) the metrics fixture. The result is in template form (what
// `data/worlds/<template>.json` holds); `seed.ts` instantiates the demo worlds for the table files.
import { worldOfClock } from "@legajo/bff/domain/common";
import type { DocType } from "@legajo/shared";
import { SEED, GENERATOR_VERSION, START_AT_SIM, TOUR_OPERATION_ID, TOUR_WINDOW_END_SIM, GUEST_TEMPLATE_CLOCK, GUEST_TEMPLATE_FIRM, GUEST_TEMPLATE_TAG, type WorldTableName } from "../lib/constants";
import { DERIVED_FIELDS, THREAD_ADDRESS_PLACEHOLDER, type SeedItem } from "../lib/items";
import type { DocVersion } from "./documents";
import { firmRows } from "./firm-rows";
import { qaFixtureRows } from "./qa-fixture";
import { rngFor } from "./rng";
import { storyOf, type PdfSize } from "./stories";
import type { WorldContext } from "./world-context";
import { operationItems, type PdfFile } from "./world-operations";
import { partyItems } from "./world-parties";

export type WorldItems = Record<WorldTableName, SeedItem[]>;

export interface BuiltWorld {
  readonly world: WorldContext;
  readonly items: WorldItems;
}

export interface PdfCatalog {
  readonly versionsByModel: ReadonlyMap<string, readonly DocVersion[]>;
  readonly files: ReadonlyMap<string, PdfFile>;
}

function emptyItems(): WorldItems {
  return { Firms: [], Parties: [], Operations: [], Conversations: [], AuditLog: [], LegajoMetrics: [], Platform: [] };
}

function pdfSizes(catalog: PdfCatalog): PdfSize {
  return {
    size(modelNumber: string, docType: DocType, versionNo: number): number {
      const version = catalog.versionsByModel.get(modelNumber)?.find((candidate) => candidate.docType === docType && candidate.versionNo === versionNo);
      const file = version === undefined ? undefined : catalog.files.get(version.docId);
      if (file === undefined) throw new RangeError(`no PDF for ${modelNumber} ${docType} v${versionNo}`);
      return file.sizeBytes;
    },
  };
}

export function buildWorld(world: WorldContext, catalog: PdfCatalog): BuiltWorld {
  const items = emptyItems();
  const confirmations = new Map<string, string>();
  const sizes = pdfSizes(catalog);
  const perOperation = world.operations.map((op) => {
    const scope = { world, op, rng: rngFor(`history:${world.template}:${op.operationId}`) };
    const story = storyOf(scope, sizes);
    if (story?.contactConfirmedAt !== undefined && world.withTimeline) confirmations.set(op.supplier.contactId, story.contactConfirmedAt);
    return operationItems({ world, op, versions: catalog.versionsByModel.get(op.model.number) ?? [], files: catalog.files, ...(story === undefined ? {} : { story }) });
  });
  if (world.ownsFirm) items.Firms.push(...firmRows(world.firm, world.brokers, world.template === "guest" ? worldOfClock(world.clockId) : undefined));
  items.Parties.push(...partyItems(world, confirmations));
  for (const produced of perOperation) {
    items.Operations.push(...produced.Operations);
    items.Conversations.push(...produced.Conversations);
    items.AuditLog.push(...produced.AuditLog);
    items.Platform.push(...produced.Platform);
  }
  if (world.template === "qa-min") items.LegajoMetrics.push(...qaFixtureRows(world));
  return { world, items };
}

/** What the world factory needs besides the items: where the ids come from and what it must derive. */
export function templateFile(built: readonly BuiltWorld[]): Record<string, unknown> {
  const first = built[0];
  if (first === undefined) throw new RangeError("a template needs a world");
  const items = emptyItems();
  for (const { items: worldItems } of built) for (const table of Object.keys(items) as WorldTableName[]) items[table].push(...worldItems[table]);
  const operations = built.flatMap(({ world }) =>
    world.operations.map((op) => ({ operationId: op.operationId, operationNumber: op.number, model: `op-${op.model.number}`, importerId: op.importer.importerId, supplierId: op.supplier.supplierId, dossierStatus: op.model.dossierStatus, firmId: world.firm.firmId, clockId: world.clockId })),
  );
  const altContacts = built.flatMap(({ world }) => world.suppliers.flatMap((supplier) => (supplier.altContact === undefined ? [] : [{ supplierId: supplier.supplierId, email: supplier.altContact }])));
  const template = first.world.template;
  return {
    template,
    generatorVersion: GENERATOR_VERSION,
    seed: SEED,
    startAtSim: START_AT_SIM,
    ...(template === "models" ? {} : { source: { firmId: first.world.firm.firmId, clockId: first.world.clockId, firmKind: first.world.firm.kind } }),
    derived: { fields: DERIVED_FIELDS, threadAddressPlaceholder: THREAD_ADDRESS_PLACEHOLDER, worldEpoch: "COUNTER#EPOCH#<clockId>", keys: "packages/bff/src/connector/item-shape.ts" },
    ...(template === "guest"
      ? {
          placeholders: { firmId: GUEST_TEMPLATE_FIRM, clockId: GUEST_TEMPLATE_CLOCK, brokerId: "brk-guest-00", mailboxTag: GUEST_TEMPLATE_TAG, phonePrefix: "+54911555100", note: "the world factory writes the guest's two digits instead of 00" },
          tour: { operationId: TOUR_OPERATION_ID, operationNumber: TOUR_OPERATION_ID.slice(3), windowStartSim: START_AT_SIM, windowEndSim: TOUR_WINDOW_END_SIM },
        }
      : {}),
    operations,
    altContacts,
    items,
  };
}
