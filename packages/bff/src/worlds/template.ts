// World templates as the world factory reads them (docs/seed-spec.md §1 and §14):
// `Seed/worlds/<template>.json`, written by `seed:load` from `scripts/seed/data/worlds/`. A template
// holds the entities of its tables without keys and without what a world derives from the stage's key
// or its epoch (thread tag and address, phone and email hashes, the epoch itself); the factory
// completes them (instantiate.ts). Templates are read from the bucket at runtime, so a seed reload
// changes the next world without a deploy. The roles with the capability `WORLDS` read them
// (docs/architecture.md §14); the bucket's name comes from its link (`Resource`, never `process.env`).
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { ToolError, WorldTemplateName, seedKeys } from "@legajo/shared";
import { awsClientConfig, type ClientTimeouts } from "../lib/clients";
import { bucketName } from "../lib/resource";
import { STAGE_REGION } from "../public-web/presign";

/** Tables a template carries items for (`Platform` items keep their `POP#` key). */
export const TEMPLATE_TABLES = ["Firms", "Parties", "Operations", "Conversations", "AuditLog", "LegajoMetrics", "Platform"] as const;
export type TemplateTable = (typeof TEMPLATE_TABLES)[number];

/** A template item: an entity without keys (or a `Platform` row with its `POP#` key). */
export type TemplateItem = Readonly<Record<string, unknown>> & { readonly entity: string };

const Item = z.record(z.string(), z.unknown()).refine((item) => typeof item.entity === "string", "every item names its entity") as unknown as z.ZodType<TemplateItem>;

export const TemplateOperation = z.object({
  operationId: z.string(),
  operationNumber: z.string(),
  model: z.string(),
  importerId: z.string(),
  supplierId: z.string(),
  dossierStatus: z.string(),
  firmId: z.string(),
  clockId: z.string(),
});
export type TemplateOperation = z.infer<typeof TemplateOperation>;

/** `scripts/seed/lib/files.ts` `WorldTemplateFile`, the same shape (the seed writes, the factory reads). */
export const WorldTemplate = z.object({
  template: WorldTemplateName,
  generatorVersion: z.string(),
  seed: z.number().int(),
  startAtSim: z.string(),
  /** Firm and clock the items are written for (absent in `models`, whose operations name theirs). */
  source: z.object({ firmId: z.string(), clockId: z.string(), firmKind: z.string() }).optional(),
  derived: z.object({ fields: z.record(z.string(), z.array(z.string())), threadAddressPlaceholder: z.string(), worldEpoch: z.string(), keys: z.string() }),
  /** The `00` markers of the `guest` template the factory replaces by the slot's two digits. */
  placeholders: z.record(z.string(), z.string()).optional(),
  tour: z.object({ operationId: z.string(), operationNumber: z.string(), windowStartSim: z.string(), windowEndSim: z.string() }).optional(),
  operations: z.array(TemplateOperation),
  altContacts: z.array(z.object({ supplierId: z.string(), email: z.string() })),
  items: z.object(Object.fromEntries(TEMPLATE_TABLES.map((table) => [table, z.array(Item)])) as Record<TemplateTable, z.ZodArray<typeof Item>>),
});
export type WorldTemplate = z.infer<typeof WorldTemplate>;

/** Where the factory reads templates from. */
export interface TemplateSource {
  read(name: WorldTemplateName): Promise<WorldTemplate>;
}

/** Templates already in memory (the seed loader's disk copy, tests, the local UI server). */
export function staticTemplateSource(templates: Partial<Record<WorldTemplateName, unknown>>): TemplateSource {
  const parsed = new Map<WorldTemplateName, WorldTemplate>();
  return {
    async read(name) {
      const cached = parsed.get(name);
      if (cached !== undefined) return cached;
      const raw = templates[name];
      if (raw === undefined) throw new ToolError("NOT_FOUND", `world template ${name} is not loaded`);
      const template = WorldTemplate.parse(raw);
      parsed.set(name, template);
      return template;
    },
  };
}

// A template is a few hundred kilobytes: one short read.
const TEMPLATE_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

export interface S3TemplateSourceOptions {
  readonly client?: S3Client;
  readonly bucket?: () => string;
}

/** `Seed/worlds/<template>.json`, read on every creation or reset (a reload of the seed applies at once). */
export function s3TemplateSource(options: S3TemplateSourceOptions = {}): TemplateSource {
  let client = options.client;
  const s3 = (): S3Client => (client ??= new S3Client({ region: STAGE_REGION, ...awsClientConfig(TEMPLATE_TIMEOUTS) }));
  const bucket = options.bucket ?? (() => bucketName("Seed"));
  return {
    async read(name) {
      const key = seedKeys.worldTemplate(name);
      let text: string | undefined;
      try {
        const object = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
        text = await object.Body?.transformToString("utf8");
      } catch (error) {
        if (error instanceof NoSuchKey) throw new ToolError("NOT_FOUND", `world template ${name} is not in the seed bucket (run seed:load)`, undefined, { cause: error });
        throw new ToolError("UNAVAILABLE", `could not read world template ${name}`, undefined, { cause: error });
      }
      if (text === undefined) throw new ToolError("UNAVAILABLE", `world template ${name} has no body`);
      return WorldTemplate.parse(JSON.parse(text) as unknown);
    },
  };
}
