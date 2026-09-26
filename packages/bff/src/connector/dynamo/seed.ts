// Seed loader and world factory entry point (docs/seed-spec.md §16): every item is validated with
// the schema of its entity (the same one the connector reads with), must belong to the table it is
// written to and must sit at the key and carry the GSI attributes the connector would give it
// (item-shape.ts); nothing is written unless every item passes. Upserts by PK + SK, so a reload is
// idempotent.
import { ConnectorError } from "@legajo/shared";
import { checkEntityItem } from "../../domain/registry";
import { shapeProblems } from "../item-shape";
import type { SeedItem, SeedStore, SeedTable } from "../ports-runtime";
import type { Item, TableClient } from "../table-client";

export function createSeedStore(client: TableClient): SeedStore {
  function validateItems(table: SeedTable, items: readonly SeedItem[]): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const id = `${item.PK}/${item.SK}`;
      if (seen.has(id)) problems.push(`${id}: duplicated key`);
      seen.add(id);
      const check = checkEntityItem(table, item);
      if (!check.ok) problems.push(`${id}: ${check.error}`);
      else problems.push(...shapeProblems(check.entity, item).map((problem) => `${id}: ${problem}`));
    }
    return problems;
  }

  return {
    validateItems,

    async loadItems(table, items) {
      const problems = validateItems(table, items);
      if (problems.length > 0) throw new ConnectorError("VALIDATION", `${problems.length} invalid seed item(s) for ${table}: ${problems.slice(0, 3).join(" | ")}`, table);
      await client.batchPut(table, items.map((item): Item => ({ ...item })));
      return { table, written: items.length };
    },
  };
}
