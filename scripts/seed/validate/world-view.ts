// A read-only view over the items of one world (a table file's slice or a template), so every
// invariant looks entities up the same way: by kind, by id, by clock.
import type { SeedItem } from "../lib/items";

export interface WorldView {
  /** What the view is: `data GLOBAL#firm-delta`, `template guest`. */
  readonly label: string;
  readonly items: readonly SeedItem[];
  of(entity: string): SeedItem[];
  find(entity: string, predicate: (item: SeedItem) => boolean): SeedItem | undefined;
}

export function worldView(label: string, items: readonly SeedItem[]): WorldView {
  const byEntity = new Map<string, SeedItem[]>();
  for (const item of items) {
    const list = byEntity.get(item.entity) ?? [];
    list.push(item);
    byEntity.set(item.entity, list);
  }
  return {
    label,
    items,
    of: (entity) => byEntity.get(entity) ?? [],
    find: (entity, predicate) => (byEntity.get(entity) ?? []).find(predicate),
  };
}

/** Items of the table files that belong to one clock (world items carry `clockId`). */
export function clockSlice(items: readonly SeedItem[], clockId: string): SeedItem[] {
  return items.filter((item) => item.clockId === clockId);
}

export const str = (value: unknown): string => (typeof value === "string" ? value : "");
