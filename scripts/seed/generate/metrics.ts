// The 200 entries of the metrics batch (docs/seed-spec.md §13): inputs only, never results. Each entry
// is one world `sim-<nnnn>` in `firm-sim` with one operation cloned from a model of Delta or Norte
// (so its PDFs and ground truth exist), the supplier's simulated behaviour, the ETA changes the
// carrier will announce and the errors the reader will return. The distributions are generator
// parameters, not market data; the validator checks the entries cover them exactly (invariant 14).
import { DocType, type SupplierBehaviour } from "@legajo/shared";
import { START_AT_SIM } from "../lib/constants";
import { operationSpec, type OperationSpec } from "./catalog-operations";
import { supplierSpec } from "./catalog-parties";
import { rngFor } from "./rng";
import { addDays, arAt, arDate, milestoneTimes } from "./time";

export const BATCH_SIZE = 200;
export const BATCH_FIRMS = { "firm-delta": 140, "firm-norte": 60 } as const;
/** Behaviour of the supplier: 60 % PROMPT, 25 % with a seeded error, 8 % BOUNCE, 5 % NEVER, the rest LATE. */
export const BATCH_BEHAVIOURS = { PROMPT: 120, SEEDED: 50, BOUNCE: 16, NEVER: 10, LATE: 4 } as const;
/** 20 % of the entries get one ETA change of −3 to +4 days. */
export const BATCH_ETA_CHANGES = 40;
export const ETA_DELTA_DAYS = { min: -3, max: 4 } as const;

/** Fields that would be results of a run: an entry never carries one (invariant 14). */
export const RESULT_FIELDS = ["assignments", "assignmentsTotal", "assignmentsCorrect", "minutes", "humanMinutes", "escalations", "violations", "turns", "outcome", "result", "results", "completedAtSim", "kpis", "costUsd", "dossierStatus"] as const;

export interface BatchEntry {
  readonly entryId: string;
  readonly clockId: string;
  readonly firmId: "firm-sim";
  /** Firm whose parties and models the entry mirrors. */
  readonly modelFirmId: keyof typeof BATCH_FIRMS;
  readonly startAtSim: string;
  readonly operation: {
    readonly key: "a";
    readonly model: string;
    readonly etaOverride: string;
    readonly authorizations: true;
    readonly consent: "GRANTED";
    readonly supplierOverride: { readonly behaviour: SupplierBehaviour; readonly delayHours?: number };
  };
  readonly supplier: { readonly timezone: string; readonly country: string };
  readonly docsAtStart: Readonly<Record<DocType, "MISSING" | "VALID" | "WITH_OBSERVATION">>;
  readonly etaChanges: readonly { readonly atSim: string; readonly newEta: string; readonly deltaDays: number }[];
  readonly seededErrors: readonly { readonly docType: DocType; readonly code: string; readonly expectedResponsible: string; readonly repeatsInV2: boolean }[];
}

const STATES = { M: "MISSING", V: "VALID", O: "WITH_OBSERVATION" } as const;
/** Models whose error lives in a document that is still missing: the supplier sends it with the error. */
const ERROR_MODELS: Readonly<Record<keyof typeof BATCH_FIRMS, readonly string[]>> = { "firm-delta": ["4471", "4479", "4486", "4493", "4494"], "firm-norte": ["5501", "5503", "5504"] };
/** Open models without a document already under observation, a history or a hostile supplier. */
const CLEAN_MODELS: Readonly<Record<keyof typeof BATCH_FIRMS, readonly string[]>> = {
  "firm-delta": ["4472", "4473", "4474", "4475", "4476", "4477", "4480", "4481", "4482", "4490", "4491", "4492"],
  "firm-norte": ["5502", "5506"],
};

type BehaviourClass = keyof typeof BATCH_BEHAVIOURS;

function classes(): BehaviourClass[] {
  return (Object.keys(BATCH_BEHAVIOURS) as BehaviourClass[]).flatMap((name) => Array.from({ length: BATCH_BEHAVIOURS[name] }, () => name));
}

function behaviourOf(klass: BehaviourClass, model: OperationSpec): SupplierBehaviour {
  if (klass === "SEEDED") return model.error?.repeatsInV2 ? "SEEDED_ERROR_TWICE" : "SEEDED_ERROR";
  return klass;
}

export function batchEntries(): BatchEntry[] {
  const rng = rngFor("batch");
  const firms = rng.shuffle([...Array.from({ length: BATCH_FIRMS["firm-delta"] }, () => "firm-delta" as const), ...Array.from({ length: BATCH_FIRMS["firm-norte"] }, () => "firm-norte" as const)]);
  const behaviours = rng.shuffle(classes());
  const etaChanged = new Set(rng.shuffle(Array.from({ length: BATCH_SIZE }, (_, index) => index)).slice(0, BATCH_ETA_CHANGES));
  return Array.from({ length: BATCH_SIZE }, (_, index): BatchEntry => {
    const modelFirmId = firms[index] ?? "firm-delta";
    const klass = behaviours[index] ?? "PROMPT";
    const model = operationSpec(rng.pick(klass === "SEEDED" ? ERROR_MODELS[modelFirmId] : CLEAN_MODELS[modelFirmId]));
    const supplier = supplierSpec(model.supplierId);
    const etaOverride = arAt(addDays(arDate(START_AT_SIM), rng.int(10, 30)), model.eta.slice(11, 16));
    const behaviour = behaviourOf(klass, model);
    const id = `sim-${String(index + 1).padStart(4, "0")}`;
    const deltaDays = etaChanged.has(index) ? rng.pick([-3, -2, -1, 1, 2, 3, 4]) : 0;
    const changeAt = arAt(addDays(arDate(milestoneTimes(etaOverride).DOCS_REQUEST), 1), "11:00");
    return {
      entryId: id,
      clockId: id,
      firmId: "firm-sim",
      modelFirmId,
      startAtSim: START_AT_SIM,
      operation: { key: "a", model: `op-${model.number}`, etaOverride, authorizations: true, consent: "GRANTED", supplierOverride: { behaviour, ...(behaviour === "LATE" ? { delayHours: supplier.params?.delayHours ?? 30 } : {}) } },
      supplier: { timezone: supplier.timezone, country: supplier.country },
      docsAtStart: Object.fromEntries(DocType.options.map((docType, position) => [docType, STATES[model.docs[position] ?? "M"]])) as BatchEntry["docsAtStart"],
      etaChanges: deltaDays === 0 ? [] : [{ atSim: changeAt, newEta: arAt(addDays(arDate(etaOverride), deltaDays), etaOverride.slice(11, 16)), deltaDays }],
      seededErrors: klass === "SEEDED" && model.error !== undefined ? [{ docType: model.error.docType, code: model.error.code, expectedResponsible: model.error.expectedResponsible, repeatsInV2: model.error.repeatsInV2 === true }] : [],
    };
  });
}

/** Counts the manifest records for the batch (docs/seed-spec.md §1, `metrics`). */
export function batchCounts(entries: readonly BatchEntry[]): Record<string, number> {
  const count = (predicate: (entry: BatchEntry) => boolean) => entries.filter(predicate).length;
  return {
    entries: entries.length,
    firmDelta: count((entry) => entry.modelFirmId === "firm-delta"),
    firmNorte: count((entry) => entry.modelFirmId === "firm-norte"),
    prompt: count((entry) => entry.operation.supplierOverride.behaviour === "PROMPT"),
    withSeededError: count((entry) => entry.seededErrors.length > 0),
    bounce: count((entry) => entry.operation.supplierOverride.behaviour === "BOUNCE"),
    never: count((entry) => entry.operation.supplierOverride.behaviour === "NEVER"),
    late: count((entry) => entry.operation.supplierOverride.behaviour === "LATE"),
    withEtaChange: count((entry) => entry.etaChanges.length > 0),
  };
}

