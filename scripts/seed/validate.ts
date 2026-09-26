// Checks the invariants of docs/seed-spec.md §15 over the committed seed and exits with 1 on the
// first run that finds a problem, listing every one. With `CI=true` and no `FORBIDDEN_TERMS` list it
// fails closed (invariant 11); a local run without the list says it did not check it.
//
//   npm run seed:validate                 validates scripts/seed/{data,pdfs}
//   tsx scripts/seed/validate.ts --root D validates D/{data,pdfs}
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSeed } from "./validate/run";

function rootArg(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--root");
  return index === -1 ? undefined : resolve(argv[index + 1] ?? ".");
}

async function main(): Promise<void> {
  const result = await validateSeed({ root: rootArg(process.argv.slice(2)) });
  for (const warning of result.warnings) console.warn(`seed:validate warning: ${warning}`);
  if (result.errors.length > 0) {
    console.error(`seed:validate: ${result.errors.length} problem(s):`);
    for (const error of result.errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log("seed:validate: every invariant of docs/seed-spec.md §15 holds.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
