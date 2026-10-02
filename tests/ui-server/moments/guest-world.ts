// The guest's world of the local captures (docs/landing-spec.md §7.2.1): the `guest` template of the
// seed (scripts/seed/data/worlds/guest.json) instantiated at epoch 1 with the seed's test key, as the
// world factory would for the template's own firm `firm-guest-00`, loaded into the in-memory stores of
// the local UI server through the seed store (every item checked against the connector's schemas), its
// broker bound to the capture's synthetic guest, and its clock paused at the moment's simulated time.
import { readFileSync } from "node:fs";
import type { MemoryStores } from "@legajo/bff/connector/index";
import { GUEST_TEMPLATE_CLOCK, GUEST_TEMPLATE_FIRM, START_AT_SIM } from "../../../scripts/seed/lib/constants";
import { WorldTemplateFile } from "../../../scripts/seed/lib/files";
import type { SeedItem } from "../../../scripts/seed/lib/items";
import { instantiateTemplate } from "../../../scripts/seed/validate/conformance";

const TEMPLATE_PATH = new URL("../../../scripts/seed/data/worlds/guest.json", import.meta.url);

/** The synthetic guest the local captures sign in as (never a real account). */
export const CAPTURE_GUEST = {
  sub: "0b7f0e2e-0000-4000-8000-0000000000c0",
  username: "guest-00",
  brokerId: "brk-guest-00",
  firmId: GUEST_TEMPLATE_FIRM,
  clockId: GUEST_TEMPLATE_CLOCK,
} as const;

export type GuestTables = Awaited<ReturnType<typeof instantiateTemplate>>;

export function readGuestTemplate(): WorldTemplateFile {
  return WorldTemplateFile.parse(JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")));
}

/** The template's items with its broker bound to the capture guest, still in template form. */
export function captureTemplate(): WorldTemplateFile {
  const template = readGuestTemplate();
  const firms = template.items.Firms.map((item): SeedItem => (item.entity === "Broker" ? { ...item, cognitoSub: CAPTURE_GUEST.sub } : item));
  return { ...template, items: { ...template.items, Firms: firms } };
}

/** Completes a template as the world of `firm-guest-00` at epoch 1 (thread addresses, hashes, keys). */
export function instantiateGuestWorld(template: WorldTemplateFile): Promise<GuestTables> {
  return instantiateTemplate(template);
}

const LOADED_TABLES = ["Firms", "Parties", "Operations", "Conversations", "AuditLog", "LegajoMetrics"] as const;

/** Loads `tables` into the stores and creates the world's clock, paused at `pausedSimNow`. */
export async function loadGuestWorld(stores: MemoryStores, tables: GuestTables, pausedSimNow: string): Promise<void> {
  for (const table of LOADED_TABLES) {
    const items = tables[table];
    if (items.length > 0) await stores.seed.loadItems(table, items as never);
  }
  await stores.connector.world.createClock({
    clockId: CAPTURE_GUEST.clockId,
    firmId: CAPTURE_GUEST.firmId,
    mode: "PAUSED",
    offsetMs: 0,
    pausedSimNow,
    startAtSim: START_AT_SIM,
    worldEpoch: 1,
    settings: { rateLimitPerHour: 20 },
  });
}
