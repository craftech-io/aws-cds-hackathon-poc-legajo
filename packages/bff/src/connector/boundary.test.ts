// The connector's contract with the rest of the repository: its GSIs and TTL are exactly the ones
// infra/storage-keys.ts creates (WP-06), and no tool, handler or router talks to DynamoDB except
// through it (docs/build-plan.md WP-07: "ninguna tool importará @aws-sdk/lib-dynamodb").
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TABLE_NAMES } from "../lib/resource";
import { INDEXES, TTL_ATTRIBUTE } from "./table-client";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BFF_SRC = join(ROOT, "packages/bff/src");

/** Source files that may import the DynamoDB SDK: the client factory and the adapter. */
const ALLOWED_DYNAMO_IMPORTERS = new Set(["lib/clients.ts", "connector/dynamo/client.ts"]);

function sources(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const InfraStorage = z.object({
  TTL_ATTRIBUTE: z.string(),
  PRIMARY_KEY: z.object({ hashKey: z.string(), rangeKey: z.string() }),
  TABLE_SPECS: z.record(z.string(), z.object({ indexes: z.record(z.string(), z.object({ hashKey: z.string(), rangeKey: z.string().optional() })), ttl: z.boolean() })),
});

describe("connector boundary", () => {
  it("is the only way to DynamoDB: nothing else in packages/bff imports @aws-sdk/lib-dynamodb or @aws-sdk/client-dynamodb", () => {
    const offenders = sources(BFF_SRC)
      .map((path) => relative(BFF_SRC, path))
      .filter((path) => !path.endsWith(".test.ts") && !ALLOWED_DYNAMO_IMPORTERS.has(path))
      .filter((path) => /from\s+["']@aws-sdk\/(?:lib-dynamodb|client-dynamodb)["']/.test(readFileSync(join(BFF_SRC, path), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("uses exactly the keys, GSIs and TTL attribute of infra/storage-keys.ts", async () => {
    const modulePath = join(ROOT, "infra/storage-keys.ts");
    const infra = InfraStorage.parse(await import(/* @vite-ignore */ modulePath));
    expect(TTL_ATTRIBUTE).toBe(infra.TTL_ATTRIBUTE);
    expect(infra.PRIMARY_KEY).toEqual({ hashKey: "PK", rangeKey: "SK" });
    for (const [table, spec] of Object.entries(infra.TABLE_SPECS)) {
      const ours = Object.fromEntries(Object.entries(INDEXES[table as keyof typeof INDEXES] ?? {}).map(([name, keys]) => [name, keys.range === undefined ? { hashKey: keys.hash } : { hashKey: keys.hash, rangeKey: keys.range }]));
      expect({ table, indexes: ours }).toEqual({ table, indexes: spec.indexes });
    }
    const storageTables = Object.keys(infra.TABLE_SPECS);
    expect(TABLE_NAMES.filter((name) => !storageTables.includes(name))).toEqual(["ReaderCatalog", "Platform"]);
  });
});
