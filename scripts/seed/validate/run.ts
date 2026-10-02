// Runs every invariant of docs/seed-spec.md §15 over a seed on disk and returns what failed. The
// generator runs it before writing the manifest (without invariant 18, which checks the manifest
// itself, and without the external forbidden list, which depends on the machine); `seed:validate`
// and the seed's tests run all of it.
import { WorldTemplateName } from "@legajo/shared";
import { DELTA_CLOCK, NORTE_CLOCK, QA_CLOCK, GUEST_TEMPLATE_CLOCK, GUEST_TEMPLATE_FIRM } from "../lib/constants";
import { readSeed, type SeedOnDisk, type WorldTemplateFile } from "../lib/files";
import type { SeedItem } from "../lib/items";
import { batchProblems, qaFixtureProblems } from "./batch";
import { tableConformance, templateConformance } from "./conformance";
import { catalogEvalProblems, catalogProblems, observationProblems, validDocumentProblems, versionCatalogProblems } from "./documents";
import { historyProblems, tourWindowProblems } from "./history";
import { controlListProblems, forbiddenTermProblems, nameCheckProblems, seedNames, seedTexts } from "./names";
import { addressProblems, addressesOf, consentAndAuthorizationProblems, injectorProblems } from "./parties";
import { checklistProblems, manifestProblems, operationShapeProblems, rateCardProblems, runtimeProblems, settingsProblems, templateProblems, threadProblems } from "./structure";
import { clockSlice, worldView, type WorldView } from "./world-view";

export interface ValidateOptions {
  readonly root?: string;
  /** Invariant 18 (the generator writes the manifest after validating). */
  readonly withManifest?: boolean;
  /** The external `FORBIDDEN_TERMS` list (invariant 11). */
  readonly forbiddenTerms?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ValidationResult {
  readonly errors: string[];
  readonly warnings: string[];
}

const DATA_WORLDS = [DELTA_CLOCK, NORTE_CLOCK, QA_CLOCK];
/** Guest worlds the thread-address uniqueness is checked for (15 accounts, never fewer than 10, plus guest-test). */
const GUEST_FIRMS = [...Array.from({ length: 15 }, (_, index) => `firm-guest-${String(index + 1).padStart(2, "0")}`), "firm-guest-test"];

function allItems(seed: SeedOnDisk): SeedItem[] {
  return Object.values(seed.tables).flatMap((table) => table.items);
}

function templateView(name: WorldTemplateName, template: WorldTemplateFile): WorldView {
  return worldView(`template ${name}`, Object.values(template.items).flat());
}

/** The guest template's operations as they would be in each guest world (only what the thread tag needs). */
function guestWorldViews(template: WorldTemplateFile): WorldView[] {
  return GUEST_FIRMS.map((firmId) =>
    worldView(
      `guest world ${firmId}`,
      template.items.Operations.filter((item) => item.entity === "Operation" && item.firmId === GUEST_TEMPLATE_FIRM).map((item) => ({ ...item, firmId, clockId: String(item.clockId).replace(GUEST_TEMPLATE_CLOCK, `GUEST#${firmId}`) })),
    ),
  );
}

export async function validateSeed(options: ValidateOptions = {}): Promise<ValidationResult> {
  const seed = readSeed(options.root);
  const items = allItems(seed);
  const reference = worldView("Reference", seed.tables.Reference.items);
  const holidays = reference.of("Holiday").filter((row) => row.country === "AR").map((row) => String(row.date));
  const worlds = DATA_WORLDS.map((clockId) => worldView(`data ${clockId}`, clockSlice(items, clockId)));
  const firms = worldView("data Firms", seed.tables.Firms.items);
  const templates = WorldTemplateName.options.flatMap((name) => {
    const template = seed.templates[name];
    return template === undefined ? [] : [{ name, template, view: templateView(name, template) }];
  });
  const templateOf = (name: WorldTemplateName) => templates.find((entry) => entry.name === name);
  const errors: string[] = [];
  const warnings: string[] = [];

  // Conformance to the domain, and templates that instantiate to their worlds.
  errors.push(...tableConformance(seed), ...(await templateConformance(seed)));
  // 1, 2
  for (const view of worlds) errors.push(...operationShapeProblems(view, true));
  for (const { name, view } of templates) errors.push(...operationShapeProblems(view, name !== "models"));
  const guest = templateOf("guest");
  const qaMin = templateOf("qa-min");
  errors.push(...(await threadProblems([...worlds.map((view) => ({ view })), ...(guest === undefined ? [] : guestWorldViews(guest.template).map((view) => ({ view })))])));
  // 3, 4, 5, 6
  for (const view of [...worlds, ...templates.map((entry) => entry.view)]) errors.push(...validDocumentProblems(view), ...observationProblems(view, reference), ...versionCatalogProblems(view, seed.tables.ReaderCatalog.items));
  errors.push(...catalogProblems(seed.tables.ReaderCatalog.items, seed.pdfs), ...catalogEvalProblems(seed.tables.ReaderCatalog.items, reference));
  // 7, 8, 9, 20
  // The demo templates, `qa-min` and `models` are the worlds of the table files; the guest template is its own.
  const deltaAltContacts = templateOf("demo-firm-delta")?.template.altContacts ?? [];
  const sharedFirms = worldView("data shared firms", seed.tables.Firms.items.filter((item) => item.entity === "Firm" && item.clockId === undefined));
  errors.push(
    ...addressProblems([
      ...worlds.flatMap((view) => addressesOf(view, view.label.endsWith(DELTA_CLOCK) ? deltaAltContacts : [])),
      ...addressesOf(sharedFirms),
      ...(guest === undefined ? [] : addressesOf(guest.view, guest.template.altContacts)),
    ]),
  );
  for (const view of [...worlds, ...templates.map((entry) => entry.view)]) errors.push(...consentAndAuthorizationProblems(view));
  for (const view of worlds) errors.push(...injectorProblems(view, view.label.endsWith(QA_CLOCK)));
  for (const { name, template, view } of templates) errors.push(...injectorProblems(view, name === "qa-min", template.altContacts));
  // 10, 21
  for (const view of [...worlds, ...templates.filter((entry) => entry.name !== "models").map((entry) => entry.view)]) errors.push(...historyProblems(view, holidays));
  for (const name of ["guest", "demo-firm-delta"] as const) {
    const entry = templateOf(name);
    if (entry !== undefined) errors.push(...tourWindowProblems(entry.view));
  }
  if (guest?.template.tour === undefined) errors.push("the guest template does not declare its tour window");
  // 11
  const texts = seedTexts(seed.dataFiles, seed.pdfs);
  errors.push(...controlListProblems(texts), ...nameCheckProblems(seedNames([...worlds, firms, ...templates.map((entry) => entry.view)]), reference));
  if (options.forbiddenTerms !== false) {
    const forbidden = forbiddenTermProblems(texts, options.env);
    errors.push(...forbidden.errors);
    warnings.push(...forbidden.warnings);
  }
  // 12, 13, 15, 16, 17
  errors.push(...templateProblems(reference, [...worlds, ...templates.map((entry) => entry.view)]));
  for (const view of [firms, ...templates.map((entry) => entry.view)]) errors.push(...settingsProblems(view), ...checklistProblems(view));
  errors.push(...rateCardProblems(reference), ...runtimeProblems([worldView("data", items), ...templates.map((entry) => entry.view)]));
  // 14, 18
  const models = new Set((templateOf("models")?.template.operations ?? []).map((operation) => operation.operationId));
  errors.push(...batchProblems(seed.batch, models), ...qaFixtureProblems(seed.qaFixture));
  if (qaMin === undefined) errors.push("the qa-min template is missing");
  if (options.withManifest !== false) errors.push(...manifestProblems(seed));
  return { errors, warnings };
}
