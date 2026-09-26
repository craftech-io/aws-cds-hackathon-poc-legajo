// The seed against the code (docs/seed-spec.md §16): every item of a domain table passes the zod schema
// of its entity and sits at the key with the GSI attributes the connector would give it (the seed
// store's own check, packages/bff/src/connector/dynamo/seed.ts), the mocks' rows pass the mocks'
// schemas, and each world template instantiated with the test key at epoch 1 is valid too; a demo
// template instantiates to exactly the items of its world in the table files.
import { createMemoryStores } from "@legajo/bff/connector/index";
import { PlatformOperationItem } from "@legajo/platform-mock/schema";
import { WorldTemplateName } from "@legajo/shared";
import { DOMAIN_TABLES, DELTA_CLOCK, NORTE_CLOCK, QA_CLOCK, type DomainTableName, type WorldTableName } from "../lib/constants";
import type { SeedOnDisk, WorldTemplateFile } from "../lib/files";
import { instantiate, type SeedItem } from "../lib/items";
import { stableStringify } from "../lib/json";

function seedStore() {
  return createMemoryStores({ now: () => new Date(0) }).seed;
}

function tableOf(table: WorldTableName): DomainTableName | undefined {
  return (DOMAIN_TABLES as readonly string[]).includes(table) ? (table as DomainTableName) : undefined;
}

/** Items of every domain table against the connector's schemas and key shapes. */
export function tableConformance(seed: SeedOnDisk): string[] {
  const store = seedStore();
  const problems = DOMAIN_TABLES.flatMap((table) => store.validateItems(table, seed.tables[table].items as never).map((problem) => `${table} ${problem}`));
  for (const item of seed.tables.Platform.items) {
    const parsed = PlatformOperationItem.safeParse(item);
    if (!parsed.success) problems.push(`Platform ${String(item.PK)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return problems;
}

/** The template's items completed as a world at epoch 1, by table. */
export async function instantiateTemplate(template: WorldTemplateFile): Promise<Record<WorldTableName, SeedItem[]>> {
  const threads = new Map<string, string>();
  const options = { worldEpoch: 1, threads };
  const { items } = template;
  const operations = await instantiate(items.Operations, options);
  return {
    Operations: operations,
    Firms: await instantiate(items.Firms, options),
    Parties: await instantiate(items.Parties, options),
    Conversations: await instantiate(items.Conversations, options),
    AuditLog: await instantiate(items.AuditLog, options),
    LegajoMetrics: await instantiate(items.LegajoMetrics, options),
    Platform: items.Platform,
  };
}

const DEMO_CLOCKS: Partial<Record<WorldTemplateName, string>> = { "demo-firm-delta": DELTA_CLOCK, "demo-firm-norte": NORTE_CLOCK, "qa-min": QA_CLOCK };

/** Every template instantiates to valid items; the demo ones to exactly their world of the table files. */
export async function templateConformance(seed: SeedOnDisk): Promise<string[]> {
  const store = seedStore();
  const problems: string[] = [];
  for (const name of WorldTemplateName.options) {
    const template = seed.templates[name];
    if (template === undefined) {
      problems.push(`world template ${name} is missing`);
      continue;
    }
    const instance = await instantiateTemplate(template);
    for (const table of Object.keys(instance) as WorldTableName[]) {
      const domain = tableOf(table);
      if (domain !== undefined) problems.push(...store.validateItems(domain, instance[table] as never).map((problem) => `template ${name} ${table} ${problem}`));
      for (const item of template.items[table]) if ("PK" in item && table !== "Platform") problems.push(`template ${name} ${table} carries keys: the world factory places the items`);
    }
    const clockId = DEMO_CLOCKS[name];
    if (clockId === undefined) continue;
    for (const table of Object.keys(instance) as WorldTableName[]) {
      const inData = seed.tables[table].items.filter((item) => item.clockId === clockId || (table === "Firms" && isFirmRowOf(item, template)));
      if (stableStringify(inData) !== stableStringify(instance[table])) problems.push(`template ${name} does not instantiate to the ${table} items of ${clockId} in the table files`);
    }
  }
  return problems;
}

function isFirmRowOf(item: SeedItem, template: WorldTemplateFile): boolean {
  return template.items.Firms.length > 0 && item.firmId === template.source?.firmId;
}
