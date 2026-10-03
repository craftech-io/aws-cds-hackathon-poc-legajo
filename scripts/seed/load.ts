// Loads the synthetic seed into the stage (docs/seed-spec.md §16). Runs inside `sst shell`, so every
// table, bucket, secret and the Memory come from the linked resources; idempotent by fingerprint.
//
//   npm run seed:load                      loads when the fingerprint (manifest + overrides) changed
//   npm run seed:load -- --force           reloads anyway (each demo world is reset: its epoch goes up)
//   npm run seed:load -- --firm firm-delta only that firm's rows and world
//
// What it writes and in which order: scripts/seed/load/run.ts.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SEED_ROOT } from "./lib/constants";
import { readSeed } from "./lib/files";
import { parseLoadArgs } from "./load/plan";
import { runLoad } from "./load/run";
import { loadOverrides, s3SeedBucket, stageLoaderWorlds } from "./load/stage";

async function main(): Promise<void> {
  const args = parseLoadArgs(process.argv.slice(2));
  const seed = readSeed();
  const report = (line: string) => process.stdout.write(`seed:load: ${line}\n`);
  const result = await runLoad(seed, args, { bucket: s3SeedBucket(), worlds: stageLoaderWorlds(seed), overrides: loadOverrides(resolve(SEED_ROOT, "overrides.local.json")), report });
  if (!result.skipped) report(`done: ${result.worlds.map((world) => `${world.clockId} epoch ${world.worldEpoch}`).join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`seed:load: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}
