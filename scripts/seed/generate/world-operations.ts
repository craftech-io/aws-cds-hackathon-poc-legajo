// Items of one operation of a world (docs/seed-spec.md §7): the operation with its dated histories,
// its three documents, every version it holds at the start with the reading the reader returned
// (the reader mock's own `composeReading` over the ground truth), the seeded observation, the five
// milestones in the state of §3, its escalations and the `Platform` row the mock serves.
import { DocType, docVersionId, documentsKeys, observationId, type DocStatus, type MilestoneName } from "@legajo/shared";
import { matrixDefault } from "@legajo/bff/domain/firms";
import { worldOfClock } from "@legajo/bff/domain/common";
import { composeReading, readingIdOf } from "@legajo/reader-mock/reading";
import { toPlatformOperationItem } from "@legajo/platform-mock/schema";
import { SEED_REAL_NOW } from "../lib/constants";
import { seedHistoryEventId } from "../lib/seed-keys";
import { templateItem, type SeedItem } from "../lib/items";
import { carrierOf, type DocStateCode } from "./catalog-operations";
import type { DocVersion } from "./documents";
import { RESPONSIBILITY_MATRIX } from "./firm-rows";
import type { DocHistory, Story, VersionSource } from "./stories";
import { MILESTONES, addDays, arAt, arDate, milestoneTimes, plusMinutes, utc } from "./time";
import type { WorldContext, WorldOperation } from "./world-context";

export const REGIME = "Importación para consumo";
const DISCHARGE_PORT = "Buenos Aires";

export interface PdfFile {
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface OperationInputs {
  readonly world: WorldContext;
  readonly op: WorldOperation;
  /** Versions with a PDF of the model, and the file of each (by `LegajoDocId`). */
  readonly versions: readonly DocVersion[];
  readonly files: ReadonlyMap<string, PdfFile>;
  readonly story?: Story;
}

export interface OperationItems {
  readonly Operations: SeedItem[];
  readonly Conversations: SeedItem[];
  readonly AuditLog: SeedItem[];
  readonly Platform: SeedItem[];
}

const STATUS: Readonly<Record<DocStateCode, DocStatus>> = { M: "MISSING", V: "VALID", O: "WITH_OBSERVATION" };

/** The operation came in from the platform about a month before its ETA, and before the demo starts. */
export function openedAtSim(eta: string): string {
  const candidate = addDays(arDate(eta), -30);
  const date = candidate < "2026-09-21" ? "2026-09-21" : candidate > "2026-10-13" ? "2026-10-13" : candidate;
  return arAt(date, "11:00");
}

/** Documents present at the start without a story: the firm loaded the invoice; the supplier sent the rest. */
function defaultHistory(op: WorldOperation, docType: DocType, index: number): DocHistory {
  const source: VersionSource = docType === "COMMERCIAL_INVOICE" ? { party: "BROKER", channel: "CONSOLE" } : { party: "SUPPLIER", channel: "EMAIL", contactId: op.supplier.contactId };
  return { versions: [{ versionNo: 1, receivedAtSim: plusMinutes(openedAtSim(op.model.eta), 180 + index), source }] };
}

function versionOf(inputs: OperationInputs, docType: DocType, versionNo: number): DocVersion {
  const found = inputs.versions.find((version) => version.docType === docType && version.versionNo === versionNo);
  if (found === undefined) throw new RangeError(`no PDF for ${inputs.op.model.number} ${docType} v${versionNo}`);
  return found;
}

function fileOf(inputs: OperationInputs, version: DocVersion): PdfFile {
  const file = inputs.files.get(version.docId);
  if (file === undefined) throw new RangeError(`no file for ${version.docId}`);
  return file;
}

function versionItem(inputs: OperationInputs, docType: DocType, entry: DocHistory["versions"][number]): SeedItem {
  const { op, world } = inputs;
  const version = versionOf(inputs, docType, entry.versionNo);
  const file = fileOf(inputs, version);
  const id = docVersionId(op.operationId, docType, entry.versionNo);
  return templateItem("DocumentVersion", {
    docVersionId: id,
    operationId: op.operationId,
    clockId: world.clockId,
    docType,
    versionNo: entry.versionNo,
    s3Key: documentsKeys.version(op.operationId, docType, entry.versionNo, file.sha256),
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    source: entry.source,
    receivedAtSim: entry.receivedAtSim,
    state: "READ",
    reading: composeReading(readingIdOf(id, file.sha256), { by: "SHA256", truth: version.reading }),
    readAtSim: plusMinutes(entry.receivedAtSim, 1),
    readerAttempts: 1,
  });
}

function observationItem(inputs: OperationInputs, docType: DocType, history: DocHistory): SeedItem | undefined {
  const { op, world, story } = inputs;
  const error = op.model.error;
  if (error === undefined || error.docType !== docType || history.versions.length === 0) return undefined;
  const first = history.versions[0];
  const last = history.versions.at(-1);
  const observed = versionOf(inputs, docType, 1).reading.observations?.[0];
  if (first === undefined || last === undefined || observed === undefined) return undefined;
  const firstId = docVersionId(op.operationId, docType, first.versionNo);
  const lastId = docVersionId(op.operationId, docType, last.versionNo);
  const events = story?.observation?.events ?? [];
  const responsible = story?.observation?.responsibleParty;
  return templateItem("Observation", {
    observationId: observationId(op.operationId, docType, error.code),
    operationId: op.operationId,
    clockId: world.clockId,
    docType,
    code: error.code,
    severity: observed.severity,
    ...(observed.field === undefined ? {} : { field: observed.field }),
    ...(observed.expected === undefined ? {} : { expected: observed.expected }),
    ...(observed.found === undefined ? {} : { found: observed.found }),
    ...(observed.againstDocType === undefined ? {} : { againstDocType: observed.againstDocType }),
    status: events.at(-1)?.status ?? "OPEN",
    ...(responsible === undefined ? {} : { responsibleParty: responsible, matchesMatrix: true }),
    matrixDefault: matrixDefault({ rules: [...RESPONSIBILITY_MATRIX], fallback: "BROKER" }, docType, error.code).responsible,
    flaggedForReview: false,
    attempts: 0,
    firstDocVersionId: firstId,
    lastDocVersionId: lastId,
    ...(story?.observation?.escalationId === undefined || !world.withTimeline ? {} : { escalationId: story.observation.escalationId }),
    history: [{ atSim: plusMinutes(first.receivedAtSim, 1), by: "SYSTEM", status: "OPEN", docVersionId: firstId }, ...events.map((event) => ({ ...event, docVersionId: lastId }))],
  });
}

function documentItems(inputs: OperationInputs): { documents: SeedItem[]; versions: SeedItem[]; observations: SeedItem[] } {
  const { op, world, story } = inputs;
  const out = { documents: [] as SeedItem[], versions: [] as SeedItem[], observations: [] as SeedItem[] };
  DocType.options.forEach((docType, index) => {
    const state = op.model.docs[index] ?? "M";
    const history = story?.docs[docType] ?? (state === "M" ? { versions: [] } : defaultHistory(op, docType, index));
    const last = history.versions.at(-1);
    const status = STATUS[state];
    out.documents.push(
      templateItem("Document", {
        operationId: op.operationId,
        clockId: world.clockId,
        docType,
        status,
        currentVersion: last?.versionNo ?? 0,
        ...(last === undefined ? {} : { currentDocVersionId: docVersionId(op.operationId, docType, last.versionNo), receivedAtSim: last.receivedAtSim }),
        ...(history.responsibleParty === undefined ? {} : { responsibleParty: history.responsibleParty }),
        ...(history.requestedFrom === undefined ? {} : { requestedFrom: history.requestedFrom, lastRequestedAtSim: history.lastRequestedAtSim }),
        ...(status === "VALID" ? { validatedBy: "READER" } : {}),
      }),
    );
    for (const entry of history.versions) out.versions.push(versionItem(inputs, docType, entry));
    const observation = observationItem(inputs, docType, history);
    if (observation !== undefined) out.observations.push(observation);
  });
  return out;
}

function milestoneItems(inputs: OperationInputs): SeedItem[] {
  const { op, world, story } = inputs;
  const times = milestoneTimes(op.model.eta);
  return MILESTONES.map((name: MilestoneName) => {
    const state = story?.milestones[name] ?? { status: "SCHEDULED" as const };
    return templateItem("Timer", {
      operationId: op.operationId,
      clockId: world.clockId,
      kind: "MILESTONE",
      timerId: name,
      dueAtSim: utc(times[name]),
      status: state.status,
      ...(state.status === "FIRED" ? { firedBy: "CLOCK", firedAtSim: state.firedAtSim ?? times[name] } : {}),
      ...(state.reason === undefined ? {} : { reason: state.reason }),
      payload: {},
    });
  });
}

function operationItem(inputs: OperationInputs): SeedItem {
  const { op, world, story } = inputs;
  const opened = openedAtSim(op.model.eta);
  const final = story?.dossier.at(-1)?.status ?? "OPEN";
  if (final !== op.model.dossierStatus) throw new RangeError(`${op.model.number}: the story ends ${final}, the spec says ${op.model.dossierStatus}`);
  return templateItem("Operation", {
    operationId: op.operationId,
    operationNumber: op.number,
    firmId: world.firm.firmId,
    clockId: world.clockId,
    importerId: op.importer.importerId,
    supplierId: op.supplier.supplierId,
    templateOperation: `op-${op.model.number}`,
    vessel: op.model.vessel,
    carrier: carrierOf(op.model.vessel),
    regime: REGIME,
    portOfLoading: op.supplier.spec.port,
    portOfDischarge: DISCHARGE_PORT,
    eta: op.model.eta,
    etaHistory: [{ eta: op.model.eta, atSim: opened, source: "SEED", eventId: seedHistoryEventId("ETA_CHANGED", op.operationId, 1) }],
    invoiceNumber: op.model.invoiceNumber,
    incoterm: op.model.incoterm,
    incotermPlace: op.model.incotermPlace,
    dossierStatus: final,
    dossierHistory: [{ atSim: opened, by: "SEED", status: "OPEN" }, ...(story?.dossier ?? [])],
    control: "AGENT",
    controlHistory: [{ atSim: opened, by: "SEED", control: "AGENT" }],
    dispatch: story?.dispatch ?? { status: "NONE", history: [] },
    sessionEpoch: 0,
    simState: { repliesSent: 0, versionsSent: {}, injectionStep: 0 },
    ...(story?.approved === undefined ? {} : { approvedBy: story.approved.by, approvedAtSim: story.approved.atSim }),
    openedAtSim: opened,
  });
}

function platformItem(inputs: OperationInputs): SeedItem {
  const { op, world, story } = inputs;
  const stamp = worldOfClock(world.clockId);
  const documents = Object.fromEntries(DocType.options.map((docType, index) => [docType, STATUS[op.model.docs[index] ?? "M"]])) as Record<DocType, DocStatus>;
  const customs = story?.dispatch === undefined ? { status: "NONE" as const } : { status: story.dispatch.status, ...(story.dispatch.channel === undefined ? {} : { channel: story.dispatch.channel }) };
  const item = toPlatformOperationItem(
    { firmId: world.firm.firmId, operationNumber: op.number, importerId: op.importer.importerId, supplierId: op.supplier.supplierId, vessel: op.model.vessel, carrier: carrierOf(op.model.vessel), regime: REGIME, port: DISCHARGE_PORT, eta: op.model.eta, invoiceNumber: op.model.invoiceNumber, incoterm: op.model.incoterm, incotermPlace: op.model.incotermPlace, documents, customs },
    { now: new Date(SEED_REAL_NOW), clockId: world.clockId, ...(stamp === undefined ? {} : { world: stamp }), synthetic: true },
  );
  return item as unknown as SeedItem;
}

/** Every item of one operation, by table. */
export function operationItems(inputs: OperationInputs): OperationItems {
  const docs = documentItems(inputs);
  const timeline = inputs.world.withTimeline;
  const story = inputs.story;
  return {
    Operations: [operationItem(inputs), ...docs.documents, ...docs.versions, ...docs.observations, ...(timeline ? [...milestoneItems(inputs), ...(story?.timers ?? []), ...(story?.escalations ?? [])] : [])],
    Conversations: timeline ? (story?.messages ?? []) : [],
    AuditLog: timeline ? (story?.decisions ?? []) : [],
    Platform: [platformItem(inputs)],
  };
}
