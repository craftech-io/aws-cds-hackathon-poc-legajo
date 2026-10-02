// `npm run landing:check` (ADR-0016 §4, FL-129): the landing's manifest, its files, the render list of
// scripts/landing/renders.json and the pictures' texts agree (rules in check-rules.ts). Runs in CI
// after the web build, needs no secret. Exit 0 with a one-line summary, 1 with every problem.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GALLERY_IDS, type MediaId } from "../../packages/web/src/views/landing/manifest";
import { MEDIA_EN } from "../../packages/web/src/views/landing/media-copy-en";
import { MEDIA_ES } from "../../packages/web/src/views/landing/media-copy-es";
import { HERO_VISUAL, TOUR_STEPS } from "../../packages/web/src/views/landing/tour-steps";
import { readCaptures } from "./captures";
import { landingProblems } from "./check-rules";
import { MANIFEST_PATH, RENDERS_PATH, publicPath } from "./manifest-file";

const REPO_DIR = join(import.meta.dirname, "../..");

const captures = readCaptures();
/** Console captures captures.json declares pending, with why: listed, never asked for. */
const PENDING = Object.entries(captures).flatMap(([id, entry]) => (entry.pending ? [[id, entry.pending] as const] : []));

/** Every id the landing shows: the renders of the hero and the tour, the gallery and the card of index.html. */
const USED_IDS: readonly MediaId[] = [...new Set<MediaId>([HERO_VISUAL.render, ...TOUR_STEPS.map((step) => step.render), ...GALLERY_IDS, "og-card"])].filter(
  (id) => !PENDING.some(([pending]) => pending === id),
);

function main(): void {
  const problems = landingProblems({
    manifest: JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
    renders: JSON.parse(readFileSync(RENDERS_PATH, "utf8")),
    usedIds: USED_IDS,
    fileExists: (src) => existsSync(publicPath(src)),
    componentSource: (path) => (existsSync(join(REPO_DIR, path)) ? readFileSync(join(REPO_DIR, path), "utf8") : undefined),
    mediaTexts: { es: MEDIA_ES.items, en: MEDIA_EN.items },
  });
  if (problems.length > 0) {
    process.stderr.write(`landing:check: ${problems.length} problem(s)\n${problems.map((problem) => `  ${problem}`).join("\n")}\n`);
    process.exit(1);
  }
  for (const [id, why] of PENDING) process.stdout.write(`landing:check: ${id} pending: ${why}\n`);
  process.stdout.write(`landing:check: manifest, files, renders and texts agree (${USED_IDS.length} ids used by the landing, ${PENDING.length} capture(s) pending)\n`);
}

main();
