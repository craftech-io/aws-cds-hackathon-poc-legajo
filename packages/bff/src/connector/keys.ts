// Partition and sort keys of every entity and the composite GSI attributes, exactly as
// docs/architecture.md §5 writes them. The seed generator, the loader and the world factory build
// the same strings through this module, so a fixture reads the same in a JSON file and in a Query.
import { padVersion, versionTag, type DocType, type ReferenceType, type TimerKind } from "@legajo/shared";
import { timerKeyOf } from "../domain/timers";
import { utcInstant } from "../domain/common";
import type { Key } from "./table-client";

export const META = "META";

// ---- Firms ---------------------------------------------------------------------------------------

export const firmPartition = (firmId: string): string => `FIRM#${firmId}`;
export const firmKey = (firmId: string): Key => ({ PK: firmPartition(firmId), SK: META });
export const firmSettingsKey = (firmId: string): Key => ({ PK: firmPartition(firmId), SK: "SETTINGS" });
export const BROKER_PREFIX = "BROKER#";
export const brokerKey = (firmId: string, brokerId: string): Key => ({ PK: firmPartition(firmId), SK: `${BROKER_PREFIX}${brokerId}` });
/** GSI1 of `Firms`: the console principal by Cognito `sub`. */
export const cognitoSubKey = (sub: string): string => `SUB#${sub}`;
export const checklistPrefix = (docType: DocType): string => `CHECKLIST#${docType}#`;
export const checklistKey = (firmId: string, docType: DocType, version: number): Key => ({ PK: firmPartition(firmId), SK: `${checklistPrefix(docType)}${versionTag(version)}` });
export const MATRIX_PREFIX = "RESP_MATRIX#";
export const matrixKey = (firmId: string, version: number): Key => ({ PK: firmPartition(firmId), SK: `${MATRIX_PREFIX}${versionTag(version)}` });

// ---- Parties -------------------------------------------------------------------------------------

export const importerPartition = (importerId: string): string => `IMP#${importerId}`;
export const importerKey = (importerId: string): Key => ({ PK: importerPartition(importerId), SK: META });
export const consentKey = (importerId: string): Key => ({ PK: importerPartition(importerId), SK: "CONSENT#WHATSAPP" });
export const AUTH_PREFIX = "AUTH#";
export const authorizationKey = (importerId: string, supplierId: string): Key => ({ PK: importerPartition(importerId), SK: `${AUTH_PREFIX}${supplierId}` });
export const supplierPartition = (supplierId: string): string => `SUP#${supplierId}`;
export const supplierKey = (supplierId: string): Key => ({ PK: supplierPartition(supplierId), SK: META });
export const CONTACT_PREFIX = "CONTACT#";
export const contactKey = (supplierId: string, contactId: string): Key => ({ PK: supplierPartition(supplierId), SK: `${CONTACT_PREFIX}${contactId}` });
export const supplierProfileKey = (supplierId: string): Key => ({ PK: supplierPartition(supplierId), SK: "PROFILE" });
/** One row per phone, email or thread address in use; its existence makes the address unique. */
export const addressClaimKey = (addressHash: string): Key => ({ PK: `ADDR#${addressHash}`, SK: "CLAIM" });
/** GSI3 of `Parties`: the registry of a firm, importers and suppliers apart. */
export const registryKey = (firmId: string, kind: "IMP" | "SUP"): string => `FIRM#${firmId}#${kind}`;

/** Sort name of the registry (GSI3 range): lower case without diacritics, so "Ñ" sorts with "n". */
export function sortNameOf(name: string): string {
  return name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

// ---- Operations ----------------------------------------------------------------------------------

export const operationPartition = (operationId: string): string => `OP#${operationId}`;
export const operationKey = (operationId: string): Key => ({ PK: operationPartition(operationId), SK: META });
export const DOC_PREFIX = "DOC#";
export const documentKey = (operationId: string, docType: DocType): Key => ({ PK: operationPartition(operationId), SK: `${DOC_PREFIX}${docType}` });
export const versionPrefix = (docType: DocType): string => `${DOC_PREFIX}${docType}#V#`;
export const versionKey = (operationId: string, docType: DocType, versionNo: number): Key => ({ PK: operationPartition(operationId), SK: `${versionPrefix(docType)}${padVersion(versionNo)}` });
export const OBS_PREFIX = "OBS#";
export const observationKey = (operationId: string, observationId: string): Key => ({ PK: operationPartition(operationId), SK: `${OBS_PREFIX}${observationId}` });
export const ESC_PREFIX = "ESC#";
export const escalationKey = (operationId: string, escalationId: string): Key => ({ PK: operationPartition(operationId), SK: `${ESC_PREFIX}${escalationId}` });
export const TIMER_PREFIX = "TIMER#";
export const timerKindPrefix = (kind: TimerKind): string => `${TIMER_PREFIX}${kind}#`;
export const timerKey = (operationId: string, kind: TimerKind, timerId: string): Key => ({ PK: operationPartition(operationId), SK: timerKeyOf(kind, timerId) });
/** GSI1 of `Operations`: the console list of a firm by dossier status, sorted by ETA. */
export const firmStatusKey = (firmId: string, status: string): string => `FIRM#${firmId}#${status}`;
/** GSI2 of `Operations`: the email thread, unique across worlds and epochs. */
export const threadKey = (operationNumber: string, threadTag: string): string => `THREAD#${operationNumber}-${threadTag}`;
/** GSI3 of `Operations` (sparse): SCHEDULED timers of a clock by `dueAtSim`. */
export const clockDueKey = (clockId: string): string => `CLOCK#${clockId}`;

// ---- Conversations -------------------------------------------------------------------------------

export const MSG_PREFIX = "MSG#";
export const messageKey = (operationId: string, sentAtSim: string, messageId: string): Key => ({ PK: operationPartition(operationId), SK: `${MSG_PREFIX}${utcInstant(sentAtSim)}#${messageId}` });
export const EVT_PREFIX = "EVT#";
export const messageEventKey = (operationId: string, atReal: string, eventId: string): Key => ({ PK: operationPartition(operationId), SK: `${EVT_PREFIX}${utcInstant(atReal)}#${eventId}` });
export const NOTE_PREFIX = "NOTE#";
export const turnNoteKey = (operationId: string, atSim: string, turnId: string): Key => ({ PK: operationPartition(operationId), SK: `${NOTE_PREFIX}${utcInstant(atSim)}#${turnId}` });
export const mailboxPartition = (address: string): string => `MAILBOX#${address}`;
export const MAIL_PREFIX = "MAIL#";
export const mailboxMessageKey = (address: string, receivedAtReal: string, id: string): Key => ({ PK: mailboxPartition(address), SK: `${MAIL_PREFIX}${utcInstant(receivedAtReal)}#${id}` });
/** GSI2 of `Conversations`: who a message is with (daily frequency, 24-hour window). */
export const importerCounterpartKey = (importerId: string): string => `IMP#${importerId}`;
export const contactCounterpartKey = (contactId: string): string => `CONTACT#${contactId}`;

// ---- AuditLog ------------------------------------------------------------------------------------

export const auditPartition = (firmId: string, month: string): string => `FIRM#${firmId}#${month}`;
export const auditKey = (firmId: string, ts: string, decisionId: string): Key => ({ PK: auditPartition(firmId, ts.slice(0, 7)), SK: `${ts}#${decisionId}` });
/** GSI1 of `AuditLog`: the trail of an operation. */
export const opAuditKey = (operationId: string): string => `OP#${operationId}`;
/** GSI2 of `AuditLog`: decisions of a firm by kind (ALLOW, DENY, DEFER, ACTION, VIOLATION). */
export const decisionKey = (firmId: string, decision: string): string => `FIRM#${firmId}#${decision}`;

// ---- Reference -----------------------------------------------------------------------------------

export const referencePartition = (type: ReferenceType, scope: string): string => `REF#${type}#${scope}`;
export const referenceKey = (type: ReferenceType, scope: string, sortKey: string): Key => ({ PK: referencePartition(type, scope), SK: sortKey });

/** Scope of each catalog (`HOLIDAY` is scoped by country, `EVAL` by operation). */
export const REFERENCE_SCOPES = {
  TEMPLATE: "WHATSAPP",
  RATECARD: "GLOBAL",
  DISPATCH_GLOSSARY: "es-AR",
  OBS_CODE: "GLOBAL",
  NAMECHECK: "GLOBAL",
} as const satisfies Partial<Record<ReferenceType, string>>;

/** Sort key of a glossary entry: `LIBERADO`, `CANAL_ASIGNADO#NARANJA`. */
export function glossarySortKey(status: string, channel?: string): string {
  return channel === undefined ? status : `${status}#${channel}`;
}

// ---- Runtime -------------------------------------------------------------------------------------

export const sessionKey = (sessionId: string): Key => ({ PK: `SESSION#${sessionId}`, SK: META });
export const turnPartition = (turnId: string): string => `TURN#${turnId}`;
export const turnKey = (turnId: string): Key => ({ PK: turnPartition(turnId), SK: META });
export const RESULT_PREFIX = "RESULT#";
export const turnResultKey = (turnId: string, tool: string, seq: number): Key => ({ PK: turnPartition(turnId), SK: `${RESULT_PREFIX}${tool}#${padVersion(seq)}` });
export const nonceKey = (nonce: string): Key => ({ PK: `NONCE#${nonce}`, SK: META });
export const uploadLinkKey = (token: string): Key => ({ PK: `LINK#${token}`, SK: META });
export const clockKey = (clockId: string): Key => ({ PK: `CLOCK#${clockId}`, SK: META });
export const idempotencyKey = (source: string, id: string): Key => ({ PK: `IDEMP#${source}#${id}`, SK: META });
export const rateKey = (clockId: string, addressHash: string, simHour: string): Key => ({ PK: `RATE#${clockId}#${addressHash}#${simHour}`, SK: META });
export const turnCapKey = (firmId: string, window: string): Key => ({ PK: `TURNCAP#${firmId}#${window}`, SK: META });
export const counterKey = (name: string): Key => ({ PK: `COUNTER#${name}`, SK: META });
/** Never deleted, not even by `world.destroy` (docs/architecture.md §8). */
export const epochCounterKey = (clockId: string): Key => counterKey(`EPOCH#${clockId}`);
export const opStateKey = (operationId: string): Key => ({ PK: `OPSTATE#${operationId}`, SK: META });
export const worldStateKey = (clockId: string): Key => ({ PK: `WORLDSTATE#${clockId}`, SK: META });
export const pendingPartition = (clockId: string): string => `PENDING#${clockId}`;
export const MAIL_PENDING_PREFIX = "MAIL#";
export const mailPendingKey = (clockId: string, mailId: string): Key => ({ PK: pendingPartition(clockId), SK: `${MAIL_PENDING_PREFIX}${mailId}` });
export const SCAN_PENDING_PREFIX = "SCAN#";
export const scanPendingKey = (clockId: string, sha8: string): Key => ({ PK: pendingPartition(clockId), SK: `${SCAN_PENDING_PREFIX}${sha8}` });
export const leaseKey = (kind: "PHONE" | "OPNUM", value: string): Key => ({ PK: `LEASE#${kind}#${value}`, SK: META });
export const tombstoneKey = (clockId: string, worldEpoch: number): Key => ({ PK: `TOMB#${clockId}#${worldEpoch}`, SK: META });
export const probeKey = (probeId: string): Key => ({ PK: `PROBE#${probeId}`, SK: META });
export const mailProbeKey = (mailId: string): Key => ({ PK: `PROBE#MAIL#${mailId}`, SK: META });

// ---- LegajoMetrics -------------------------------------------------------------------------------

export const kpiKey = (firmId: string, source: string, clockId: string, operationId: string): Key => ({ PK: firmPartition(firmId), SK: `${source}#${clockId}#${operationId}` });
