// The rules of `npm run landing:check` (ADR-0016 §4, docs/landing-spec.md §7.4, FL-129) as a pure
// function over what is on disk, so check.test.ts can drive every rule with a small fixture:
//
//   - the manifest validates (version 2, each status with its fields and none of the others');
//   - every file an entry names exists, and every id the landing uses has an entry;
//   - every render of the manifest is in scripts/landing/renders.json with the same component,
//     textSources, replacedBy and replaceIn, and every render of renders.json is in the manifest;
//     each one with its reason, policy (`swap` | `zoom`) and until; its component file exports the
//     component it names;
//   - a `swap` render whose `replacedBy` is already a capture of `poc` fails (it has to leave the
//     manifest and renders.json in the same commit); a `zoom` render never fails for that, and a
//     `local` capture never triggers the swap;
//   - no placeholder in the hero or as `og-card`;
//   - every id of the manifest has its alt text and caption in Spanish and English.
import { z } from "zod";
import { LandingManifest, MediaId, type ManifestEntry, RENDER_IDS, entryFiles } from "../../packages/web/src/views/landing/manifest";

export const RenderPolicy = z.enum(["swap", "zoom"]);
export type RenderPolicy = z.infer<typeof RenderPolicy>;

export const RenderRecord = z
  .object({
    component: z.string().min(1),
    textSources: z.array(z.string().min(1)).min(1),
    replacedBy: MediaId,
    replaceIn: z.string().regex(/^WP-\d{2}$/),
    reason: z.string().min(1),
    policy: RenderPolicy,
    until: z.string().min(1),
  })
  .strict();
export type RenderRecord = z.infer<typeof RenderRecord>;

export const RendersFile = z.partialRecord(z.enum(RENDER_IDS), RenderRecord);
export type RendersFile = z.infer<typeof RendersFile>;

/** Ids that may never be a placeholder: the hero's conversation and the Open Graph card. */
export const NO_PLACEHOLDER_IDS: readonly MediaId[] = ["hero-conversation", "og-card"];

export interface CheckInput {
  readonly manifest: unknown;
  readonly renders: unknown;
  /** Ids the landing shows (renders of the hero and the tour, gallery captures, the card of index.html). */
  readonly usedIds: readonly MediaId[];
  readonly fileExists: (src: string) => boolean;
  /** Source of a component file (repository path), to see that it exports what renders.json names. */
  readonly componentSource: (path: string) => string | undefined;
  /** Alt text and caption of every id, by language. */
  readonly mediaTexts: Readonly<Record<string, Readonly<Record<string, { readonly alt: string; readonly caption: string }>>>>;
}

function issues(error: z.ZodError, what: string): string[] {
  return error.issues.map((issue) => `${what}: ${issue.path.join(".") || "(root)"} ${issue.message}`);
}

function sameRender(entry: Extract<ManifestEntry, { status: "render" }>, record: RenderRecord): boolean {
  return entry.component === record.component && entry.replacedBy === record.replacedBy && entry.replaceIn === record.replaceIn && JSON.stringify(entry.textSources) === JSON.stringify(record.textSources);
}

function componentProblems(id: string, component: string, source: (path: string) => string | undefined): string[] {
  const [path = "", name] = component.split("#");
  const text = source(path);
  if (text === undefined) return [`${id}: component file ${path} does not exist`];
  if (name && !new RegExp(`(export\\s+(default\\s+)?function\\s+${name}\\b|function\\s+${name}\\b)`).test(text)) return [`${id}: ${path} has no component ${name}`];
  return [];
}

export function landingProblems(input: CheckInput): string[] {
  const manifestResult = LandingManifest.safeParse(input.manifest);
  if (!manifestResult.success) return issues(manifestResult.error, "manifest");
  const rendersResult = RendersFile.safeParse(input.renders);
  if (!rendersResult.success) return issues(rendersResult.error, "renders.json");
  const manifest = manifestResult.data;
  const renders = rendersResult.data;
  const problems: string[] = [];

  for (const entry of manifest.entries) for (const src of entryFiles(entry)) if (!input.fileExists(src)) problems.push(`${entry.id}/${entry.viewport}: ${src} does not exist`);
  for (const id of input.usedIds) if (!manifest.entries.some((entry) => entry.id === id)) problems.push(`${id}: the landing uses it but the manifest has no entry`);

  const pocCaptures = new Set(manifest.entries.filter((entry) => entry.status === "capture" && entry.origin === "poc").map((entry) => entry.id));
  for (const entry of manifest.entries) {
    if (entry.status === "placeholder" && NO_PLACEHOLDER_IDS.includes(entry.id)) problems.push(`${entry.id}: never a placeholder in the hero or as og-card`);
    if (entry.status !== "render") continue;
    const record = renders[entry.id as keyof RendersFile];
    if (!record) {
      problems.push(`${entry.id}: render of the manifest missing from renders.json`);
      continue;
    }
    if (!sameRender(entry, record)) problems.push(`${entry.id}/${entry.viewport}: component, textSources, replacedBy or replaceIn differ from renders.json`);
  }
  for (const [id, record] of Object.entries(renders)) {
    if (!record) continue;
    if (!manifest.entries.some((entry) => entry.id === id && entry.status === "render")) problems.push(`${id}: render of renders.json missing from the manifest`);
    if (record.policy === "swap" && pocCaptures.has(record.replacedBy)) problems.push(`${id}: swap render whose capture ${record.replacedBy} is already from poc: remove it from the manifest and renders.json`);
    problems.push(...componentProblems(id, record.component, input.componentSource));
  }

  for (const id of new Set(manifest.entries.map((entry) => entry.id))) {
    for (const [lang, texts] of Object.entries(input.mediaTexts)) {
      const text = texts[id];
      if (!text || text.alt.trim() === "" || text.caption.trim() === "") problems.push(`${id}: no alt text or caption in ${lang}`);
    }
  }
  return problems;
}

/** One row of `npm run landing:renders`. */
export interface RenderRow {
  readonly id: string;
  readonly replacedBy: string;
  /** What the manifest has for `replacedBy` now: `capture (poc)`, `capture (local)`, `render`, … or `missing`. */
  readonly capture: string;
  readonly policy: RenderPolicy;
  readonly until: string;
}

export function rendersReport(manifest: LandingManifest, renders: RendersFile): RenderRow[] {
  return Object.entries(renders).flatMap(([id, record]) => {
    if (!record) return [];
    const entries = manifest.entries.filter((entry) => entry.id === record.replacedBy);
    const states = [...new Set(entries.map((entry) => (entry.status === "capture" ? `capture (${entry.origin})` : entry.status)))];
    return [{ id, replacedBy: record.replacedBy, capture: states.length > 0 ? states.join(", ") : "missing", policy: record.policy, until: record.until }];
  });
}
