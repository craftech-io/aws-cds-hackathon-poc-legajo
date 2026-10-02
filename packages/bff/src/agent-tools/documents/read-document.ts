// `read_document` (docs/tool-catalog.md, ADR-0003): the external reader's reading of one version of
// the turn's operation. The model never sees the PDF, its file name or its metadata; it sees what the
// reader answered, with every text that came out of the document masked. A version still waiting for
// its reading (the reader failed when it came in) is read now, with `Idempotency-Key` = its id, and
// what that reading does to the dossier (observations, attempts, escalations, the document's status)
// is the same as in the intake (intake/pending.ts). The type is always the reader's.
import { type DocType, fail, observationId as observationIdOf, ok } from "@legajo/shared";
import type { Reading } from "@legajo/reader-contract";
import { OBSERVATION_LABELS } from "../../copy/observation-labels";
import type { DocumentVersion } from "../../domain/documents";
import { isPendingVersion } from "../../intake/document-status";
import { recordEscalation } from "../../intake/escalation-rules";
import { readPendingVersion } from "../../intake/pending";
import type { ReadingDeps } from "../../intake/ports";
import { maskText } from "../../lib/mask";
import type { ToolContext, ToolImplementation, ToolResponse } from "../common/context";
import type { ToolInput } from "../common/define";
import type { DocumentToolPorts } from "./ports";
import type { DOCUMENTS_TOOLS } from "./schema";

type Input = ToolInput<(typeof DOCUMENTS_TOOLS)["read_document"]>;

/** Fields of a reading the model may see (docs/tool-catalog.md); a buyer's tax id or name never goes out. */
const VISIBLE_FIELDS = ["documentNumber", "invoiceNumber", "incoterm", "grossWeightKg", "netWeightKg", "packages", "originCountry", "signed", "stamped"] as const;

const masked = (value: string | undefined): string | undefined => (value === undefined ? undefined : maskText(value));

function fieldsOut(reading: Reading): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of VISIBLE_FIELDS) {
    const value = reading.fields?.[field];
    if (value !== undefined) out[field] = typeof value === "string" ? maskText(value) : value;
  }
  return out;
}

function readingOut(operationId: string, docType: DocType, reading: Reading) {
  return {
    status: reading.status,
    ...(reading.docType === undefined ? {} : { docType: reading.docType }),
    ...(reading.confidence === undefined ? {} : { confidence: reading.confidence }),
    fields: fieldsOut(reading),
    observations:
      reading.status === "RECOGNIZED"
        ? (reading.observations ?? []).map((entry) => {
            const expected = masked(entry.expected);
            const found = masked(entry.found);
            return {
              observationId: observationIdOf(operationId, docType, entry.code),
              code: entry.code,
              label: OBSERVATION_LABELS[entry.code].es,
              ...(entry.field === undefined ? {} : { field: entry.field }),
              ...(expected === undefined ? {} : { expected }),
              ...(found === undefined ? {} : { found }),
              severity: entry.code === "LOW_CONFIDENCE" ? "BLOCKING" : entry.severity,
            };
          })
        : [],
  };
}

/** What the model reads of a version: the document it is (the reader's type), where it came from and its reading. */
export function versionOut(version: DocumentVersion) {
  const docType = version.reading?.docType ?? version.classifiedAs ?? version.docType;
  return {
    docType,
    versionNo: version.versionNo,
    source: { party: version.source.party, channel: version.source.channel },
    reading: version.reading === undefined ? { status: "ERROR" as const, fields: {}, observations: [] } : readingOut(version.operationId, docType, version.reading),
  };
}

function readingDeps(ctx: ToolContext<Input>, ports: DocumentToolPorts): ReadingDeps {
  return {
    connector: ctx.connector,
    reader: ports.reader(),
    documents: { sourceUrl: ports.sourceUrl },
    escalate: recordEscalation(ctx.connector, ctx.wallClock),
    wallClock: ctx.wallClock,
    log: ctx.log,
  };
}

async function readNow(ctx: ToolContext<Input>, ports: DocumentToolPorts, version: DocumentVersion): Promise<ToolResponse> {
  const operation = await ctx.connector.operations.getOperation(ctx.scope.operationId);
  const result = await readPendingVersion(readingDeps(ctx, ports), operation, version, ctx.scope.nowSim);
  if (result.kind === "UNAVAILABLE") return fail("UNAVAILABLE", "the document reader did not answer; the version stays received and is read again later. Do not describe its contents.");
  return ok(versionOut(result.version));
}

export function readDocument(ports: DocumentToolPorts): ToolImplementation<Input> {
  return async (ctx) => {
    const version = await ctx.connector.documents.findVersion(ctx.input.docVersionId);
    if (version === undefined || version.operationId !== ctx.scope.operationId) return fail("NOT_FOUND", "no such document version in this operation");
    if (isPendingVersion(version)) return readNow(ctx, ports, version);
    return ok(versionOut(version));
  };
}
