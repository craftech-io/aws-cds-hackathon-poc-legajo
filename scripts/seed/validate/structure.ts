// Structural invariants of docs/seed-spec.md §15: 1 (three documents and five milestones per
// operation, due at the ETA's times), 2 (numbers in their firm's range; thread addresses whose tag the
// validator recomputes with the test key; `THREAD#` unique across every world and instantiated
// template), 12 (templates), 13 (assumptions labelled), 15 (rate card), 16 (no Runtime), 17
// (checklists) and 18 (manifest counts and checksums).
import { OPERATION_NUMBER_RANGES, computeThreadTag, threadAddress, type OperationNumberRange } from "@legajo/shared";
import { TEMPLATE_BUTTON_MAX_CHARS } from "@legajo/bff/copy/buttons";
import { placeholderNumbers } from "@legajo/bff/copy/helpers";
import { entitiesOf } from "@legajo/bff/domain/registry";
import { Manifest, type SeedOnDisk } from "../lib/files";
import { sha256Hex } from "../lib/json";
import { SEED_TEST_THREAD_KEY } from "../lib/seed-keys";
import { str, type WorldView } from "./world-view";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AR_OFFSET = -3 * HOUR;

/** 10:00 in Buenos Aires `days` before the ETA's local date (CONTEXT.md "Hito"). */
function tenAmBefore(eta: number, days: number): number {
  const local = new Date(eta + AR_OFFSET);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return midnightLocal - days * DAY + 10 * HOUR - AR_OFFSET;
}

function expectedDue(eta: number): Record<string, number> {
  return { DOCS_REQUEST: tenAmBefore(eta, 7), FOLLOWUP: tenAmBefore(eta, 5), FOLLOWUP_FINAL: tenAmBefore(eta, 3), ESCALATION: eta - 2 * DAY, ARRIVAL: eta };
}

/** Invariant 1 for a world with a timeline (every world but `models`). */
export function operationShapeProblems(view: WorldView, withMilestones: boolean): string[] {
  const problems: string[] = [];
  for (const operation of view.of("Operation")) {
    const id = str(operation.operationId);
    const docs = view.of("Document").filter((doc) => doc.operationId === id).map((doc) => str(doc.docType)).sort();
    if (docs.join(",") !== "CERTIFICATE_OF_ORIGIN,COMMERCIAL_INVOICE,PACKING_LIST") problems.push(`${view.label}: ${id} has documents ${docs.join(",") || "none"}`);
    if (!withMilestones) continue;
    const milestones = view.of("Timer").filter((timer) => timer.operationId === id && timer.kind === "MILESTONE");
    const due = expectedDue(Date.parse(str(operation.eta)));
    if (milestones.length !== 5) problems.push(`${view.label}: ${id} has ${milestones.length} milestones`);
    for (const milestone of milestones) {
      const expected = due[str(milestone.timerId)];
      if (expected === undefined || Date.parse(str(milestone.dueAtSim)) !== expected) problems.push(`${view.label}: ${id} ${str(milestone.timerId)} is due at ${str(milestone.dueAtSim)}, not at its ETA's time`);
    }
  }
  return problems;
}

function rangeOf(firmId: string): OperationNumberRange | undefined {
  if (firmId === "firm-norte") return "norte";
  if (firmId === "firm-qa" || firmId === "firm-sim") return "qa";
  return "delta";
}

/** Invariant 2: numbers per firm range, recomputed thread tags, one `THREAD#` per address. */
export async function threadProblems(views: readonly { view: WorldView; worldEpoch?: number }[], seen: Map<string, string> = new Map()): Promise<string[]> {
  const problems: string[] = [];
  for (const { view, worldEpoch = 1 } of views) {
    const numbers = new Set<string>();
    for (const operation of view.of("Operation")) {
      const number = str(operation.operationNumber);
      const range = OPERATION_NUMBER_RANGES[rangeOf(str(operation.firmId)) ?? "delta"];
      if (Number(number) < range.min || Number(number) > range.max) problems.push(`${view.label}: operation ${number} is out of its firm's range`);
      if (numbers.has(number)) problems.push(`${view.label}: operation number ${number} repeats`);
      numbers.add(number);
      const tag = await computeThreadTag(SEED_TEST_THREAD_KEY, { operationNumber: number, clockId: str(operation.clockId), worldEpoch });
      if (operation.threadTag !== undefined && (operation.threadTag !== tag || operation.threadAddress !== threadAddress(number, tag))) problems.push(`${view.label}: ${str(operation.operationId)} has a thread tag the test key does not give`);
      const key = `THREAD#${number}-${tag}`;
      const owner = `${view.label}/${str(operation.operationId)}`;
      if (seen.has(key) && seen.get(key) !== owner) problems.push(`${key} of ${owner} is also ${seen.get(key) ?? "?"}`);
      seen.set(key, owner);
    }
  }
  return problems;
}

/** Invariant 12: every template a message names exists, starts and ends with text, buttons ≤ 25. */
export function templateProblems(reference: WorldView, messages: readonly WorldView[]): string[] {
  const problems: string[] = [];
  const templates = new Map(reference.of("Template").map((template) => [str(template.name), template]));
  for (const template of templates.values()) {
    const body = str(template.body);
    if (/^\{\{\d+\}\}|\{\{\d+\}\}$/.test(body.trim())) problems.push(`template ${str(template.name)} starts or ends with a parameter`);
    if (placeholderNumbers(body).length !== template.paramCount) problems.push(`template ${str(template.name)} declares ${String(template.paramCount)} parameters`);
    for (const button of (template.buttons as { text: string }[] | undefined) ?? []) if ([...button.text].length > TEMPLATE_BUTTON_MAX_CHARS) problems.push(`template ${str(template.name)} has a button over ${TEMPLATE_BUTTON_MAX_CHARS} characters`);
  }
  for (const view of messages) {
    for (const message of view.of("Message")) {
      const name = (message.template as { name?: string } | undefined)?.name;
      if (name !== undefined && !templates.has(name)) problems.push(`${view.label}: ${str(message.messageId)} uses template ${name}, not in TEMPLATE#WHATSAPP`);
    }
  }
  return problems;
}

type Labelled = { label?: unknown; source?: unknown; items?: { label?: unknown }[] };

/** Invariant 13: every assumption of the firm's settings says "supuesto" and its source. */
export function settingsProblems(view: WorldView): string[] {
  const problems: string[] = [];
  for (const settings of view.of("FirmSettings")) {
    for (const field of ["manualBaseline", "humanActionMinutes", "assumptions"]) {
      const value = settings[field] as Labelled | undefined;
      if (value?.label !== "supuesto" || typeof value.source !== "string" || value.source === "") problems.push(`${view.label}: ${str(settings.firmId)} ${field} is not labelled "supuesto" with its source`);
      if ((value?.items ?? []).some((item) => item.label !== "supuesto")) problems.push(`${view.label}: ${str(settings.firmId)} ${field} has an item not labelled "supuesto"`);
    }
  }
  return problems;
}

/** Invariant 15: a verified rate has price, source and date. */
export function rateCardProblems(reference: WorldView): string[] {
  return reference
    .of("RateCard")
    .filter((rate) => rate.provisional !== true && (rate.price === null || rate.price === undefined || rate.source === undefined || rate.asOf === undefined))
    .map((rate) => `RATECARD ${str(rate.rateId)} is not provisional but lacks price, source or date`);
}

const RUNTIME_ENTITIES = new Set<string>(entitiesOf("Runtime"));

/** Invariant 16: nothing of `Runtime` is seeded (the loader creates the clocks). */
export function runtimeProblems(views: readonly WorldView[]): string[] {
  return views.flatMap((view) => view.items.filter((item) => RUNTIME_ENTITIES.has(item.entity)).map((item) => `${view.label}: ${item.entity} is Runtime state and is never seeded`));
}

/** Invariant 17: 19 checklist items per firm, unique ids, the three document types. */
export function checklistProblems(view: WorldView): string[] {
  const problems: string[] = [];
  const byFirm = new Map<string, { ids: string[]; types: Set<string> }>();
  for (const checklist of view.of("Checklist")) {
    const entry = byFirm.get(str(checklist.firmId)) ?? { ids: [], types: new Set<string>() };
    entry.types.add(str(checklist.docType));
    for (const item of (checklist.items as { itemId: string }[] | undefined) ?? []) entry.ids.push(item.itemId);
    byFirm.set(str(checklist.firmId), entry);
  }
  for (const [firmId, entry] of byFirm) {
    if (entry.ids.length !== 19 || new Set(entry.ids).size !== 19 || entry.types.size !== 3) problems.push(`${view.label}: ${firmId} checklist has ${entry.ids.length} items, ${new Set(entry.ids).size} unique, ${entry.types.size} document types`);
  }
  return problems;
}

/** Invariant 18: the manifest's counts and checksums match the files. */
export function manifestProblems(seed: SeedOnDisk): string[] {
  const parsed = Manifest.safeParse(seed.manifest);
  if (!parsed.success) return [`manifest.json is missing or malformed: ${parsed.error.issues[0]?.message ?? ""}`];
  const manifest = parsed.data;
  const problems: string[] = [];
  for (const [table, file] of Object.entries(seed.tables)) {
    const entry = manifest.tables[table];
    const bytes = seed.dataFiles.get(`${table}.json`);
    if (entry === undefined || bytes === undefined || entry.count !== file.items.length || file.count !== file.items.length || entry.sha256 !== sha256Hex(bytes)) problems.push(`manifest: ${table} count or checksum differs from the file`);
  }
  for (const [name, entry] of Object.entries(manifest.worlds)) {
    const bytes = seed.dataFiles.get(`worlds/${name}.json`);
    if (bytes === undefined || entry.sha256 !== sha256Hex(bytes)) problems.push(`manifest: world template ${name} checksum differs`);
  }
  if (manifest.pdfs.count !== seed.pdfs.size) problems.push(`manifest: ${manifest.pdfs.count} PDFs, ${seed.pdfs.size} on disk`);
  for (const [path, bytes] of seed.pdfs) if (manifest.pdfs.files[path] !== sha256Hex(bytes)) problems.push(`manifest: pdfs/${path} checksum differs`);
  const batch = seed.dataFiles.get("metrics/batch-inputs.jsonl");
  const fixture = seed.dataFiles.get("metrics/qa-fixture.json");
  if (batch === undefined || manifest.metrics.batch.sha256 !== sha256Hex(batch)) problems.push("manifest: batch inputs checksum differs");
  if (fixture === undefined || manifest.metrics.qaFixture.sha256 !== sha256Hex(fixture)) problems.push("manifest: QA fixture checksum differs");
  if (JSON.stringify(manifest.metrics.qaFixture.aggregates) !== JSON.stringify(seed.qaFixture?.aggregates)) problems.push("manifest: QA aggregates differ from the fixture");
  return problems;
}
