// Generates the synthetic seed (docs/seed-spec.md): data/*.json, the world templates, the metrics
// inputs and fixture, pdfs/ and the manifest. Deterministic: seed 20260925, no Intl, canonical JSON;
// two runs in separate processes write the same bytes. The invariants of §15 run over what was
// written and their result goes into the manifest; a failing invariant exits with 1.
//
//   npm run seed:generate                 writes scripts/seed/{data,pdfs}
//   tsx scripts/seed/generate.ts --out D  writes D/{data,pdfs} (the determinism test)
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedPaths } from "./lib/constants";
import { buildSeed } from "./generate/seed";
import { writeManifest, writeSeed } from "./generate/write";
import { validateSeed } from "./validate/run";

export async function generate(root?: string): Promise<{ errors: readonly string[]; warnings: readonly string[] }> {
  const paths = seedPaths(root);
  const bundle = await buildSeed();
  const written = writeSeed(bundle, paths);
  // The manifest records only what does not depend on the machine: the forbidden-terms list is an
  // external secret, so `seed:validate` and `lint:forbidden` check it, not the generator.
  const result = await validateSeed({ root: paths.root, withManifest: false, forbiddenTerms: false });
  writeManifest(bundle, written, result, paths);
  return result;
}

function outArg(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--out");
  return index === -1 ? undefined : resolve(argv[index + 1] ?? ".");
}

async function main(): Promise<void> {
  const result = await generate(outArg(process.argv.slice(2)));
  for (const warning of result.warnings) console.warn(`seed:generate warning: ${warning}`);
  if (result.errors.length > 0) {
    console.error(`seed:generate: ${result.errors.length} invariant(s) failed:`);
    for (const error of result.errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log("seed:generate: seed written and valid.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
