// Where each entity lives and which GSI attributes it carries, derived from its own fields with the
// builders of keys.ts: the same rules the repositories write with. The seed generator, the loader and
// the world factory write items directly (docs/seed-spec.md §1: "cada item con PK, SK, atributos de
// GSI"), so the seed store checks every item against these before writing it: a seeded operation
// that would not show up in the console list or a timer the clock would never find fails the load.
import { DocType, TimerKind } from "@legajo/shared";
import { utcInstant, type EntityName } from "../domain/common";
import {
  REFERENCE_SCOPES,
  glossarySortKey,
  addressClaimKey,
  auditKey,
  authorizationKey,
  brokerKey,
  checklistKey,
  clockDueKey,
  cognitoSubKey,
  consentKey,
  contactCounterpartKey,
  contactKey,
  decisionKey,
  documentKey,
  escalationKey,
  firmKey,
  firmSettingsKey,
  firmStatusKey,
  importerCounterpartKey,
  importerKey,
  kpiKey,
  mailboxMessageKey,
  matrixKey,
  messageEventKey,
  messageKey,
  observationKey,
  opAuditKey,
  operationKey,
  referenceKey,
  registryKey,
  sortNameOf,
  supplierKey,
  supplierProfileKey,
  threadKey,
  timerKey,
  turnNoteKey,
  versionKey,
} from "./keys";
import type { Key } from "./table-client";

type Fields = Readonly<Record<string, unknown>>;

// Items reach these functions already validated by their entity schema.
const s = (fields: Fields, name: string): string => String(fields[name]);
const n = (fields: Fields, name: string): number => Number(fields[name]);
const docType = (fields: Fields): DocType => DocType.parse(fields.docType);

/** Primary key of a seedable entity; `undefined` for runtime-only entities (never seeded). */
const KEYS: Partial<Record<EntityName, (fields: Fields) => Key>> = {
  Firm: (f) => firmKey(s(f, "firmId")),
  FirmSettings: (f) => firmSettingsKey(s(f, "firmId")),
  Broker: (f) => brokerKey(s(f, "firmId"), s(f, "brokerId")),
  Checklist: (f) => checklistKey(s(f, "firmId"), docType(f), n(f, "checklistVersion")),
  ResponsibilityMatrix: (f) => matrixKey(s(f, "firmId"), n(f, "matrixVersion")),
  Importer: (f) => importerKey(s(f, "importerId")),
  Consent: (f) => consentKey(s(f, "importerId")),
  SupplierAuthorization: (f) => authorizationKey(s(f, "importerId"), s(f, "supplierId")),
  Supplier: (f) => supplierKey(s(f, "supplierId")),
  SupplierContact: (f) => contactKey(s(f, "supplierId"), s(f, "contactId")),
  SupplierProfile: (f) => supplierProfileKey(s(f, "supplierId")),
  AddressClaim: (f) => addressClaimKey(s(f, "addressHash")),
  Operation: (f) => operationKey(s(f, "operationId")),
  Document: (f) => documentKey(s(f, "operationId"), docType(f)),
  DocumentVersion: (f) => versionKey(s(f, "operationId"), docType(f), n(f, "versionNo")),
  Observation: (f) => observationKey(s(f, "operationId"), s(f, "observationId")),
  Escalation: (f) => escalationKey(s(f, "operationId"), s(f, "escalationId")),
  Timer: (f) => timerKey(s(f, "operationId"), TimerKind.parse(f.kind), s(f, "timerId")),
  Message: (f) => messageKey(s(f, "operationId"), s(f, "sentAtSim"), s(f, "messageId")),
  MessageEvent: (f) => messageEventKey(s(f, "operationId"), s(f, "atReal"), s(f, "eventId")),
  TurnNote: (f) => turnNoteKey(s(f, "operationId"), s(f, "atSim"), s(f, "turnId")),
  MailboxMessage: (f) => mailboxMessageKey(s(f, "mailboxAddress"), s(f, "receivedAtReal"), s(f, "mailboxMessageId")),
  Decision: (f) => auditKey(s(f, "firmId"), s(f, "ts"), s(f, "decisionId")),
  Holiday: (f) => referenceKey("HOLIDAY", s(f, "country"), s(f, "date")),
  Template: (f) => referenceKey("TEMPLATE", REFERENCE_SCOPES.TEMPLATE, s(f, "name")),
  RateCard: (f) => referenceKey("RATECARD", REFERENCE_SCOPES.RATECARD, s(f, "rateId")),
  DispatchGlossary: (f) => referenceKey("DISPATCH_GLOSSARY", REFERENCE_SCOPES.DISPATCH_GLOSSARY, glossarySortKey(s(f, "status"), f.channel === undefined ? undefined : s(f, "channel"))),
  ObservationCode: (f) => referenceKey("OBS_CODE", REFERENCE_SCOPES.OBS_CODE, s(f, "code")),
  EvalTruth: (f) => referenceKey("EVAL", s(f, "operationId"), s(f, "observationId")),
  NameCheck: (f) => referenceKey("NAMECHECK", REFERENCE_SCOPES.NAMECHECK, s(f, "name")),
  DossierKpi: (f) => kpiKey(s(f, "firmId"), s(f, "source"), s(f, "clockId"), s(f, "operationId")),
};

export function expectedKey(entity: EntityName, fields: Fields): Key | undefined {
  return KEYS[entity]?.(fields);
}

/** GSI attributes an item of this entity must carry (sparse ones only when they apply). */
export function expectedIndexAttributes(entity: EntityName, fields: Fields): Record<string, string> {
  switch (entity) {
    case "Broker":
      return typeof fields.cognitoSub === "string" && fields.cognitoSub !== "" ? { cognitoSubKey: cognitoSubKey(fields.cognitoSub) } : {};
    case "Importer":
      return { firmKey: registryKey(s(fields, "firmId"), "IMP"), sortName: sortNameOf(s(fields, "name")) };
    case "Supplier":
      return { firmKey: registryKey(s(fields, "firmId"), "SUP"), sortName: sortNameOf(s(fields, "name")) };
    case "Operation":
      return {
        firmStatusKey: firmStatusKey(s(fields, "firmId"), s(fields, "dossierStatus")),
        etaSort: utcInstant(s(fields, "eta")),
        threadKey: threadKey(s(fields, "operationNumber"), s(fields, "threadTag")),
      };
    case "Timer":
      return fields.status === "SCHEDULED" ? { clockDueKey: clockDueKey(s(fields, "clockId")) } : {};
    case "Message":
      if (fields.counterpart === "IMPORTER" && typeof fields.importerId === "string") return { counterpartKey: importerCounterpartKey(fields.importerId) };
      if (fields.counterpart === "SUPPLIER" && typeof fields.contactId === "string") return { counterpartKey: contactCounterpartKey(fields.contactId) };
      return {};
    case "Decision":
      return { decisionKey: decisionKey(s(fields, "firmId"), s(fields, "decision")), ...(typeof fields.operationId === "string" ? { opKey: opAuditKey(fields.operationId) } : {}) };
    default:
      return {};
  }
}

/** Instants that are range keys of an index: they must be stored in canonical UTC to sort. */
const CANONICAL_INSTANTS: Partial<Record<EntityName, readonly string[]>> = {
  Timer: ["dueAtSim"],
  Message: ["sentAtSim"],
  Decision: ["ts"],
};

/** Problems of an item's placement: wrong key, missing or stale GSI attributes, non-canonical sort instants. */
export function shapeProblems(entity: EntityName, item: Fields): string[] {
  const problems: string[] = [];
  try {
    const key = expectedKey(entity, item);
    if (key && (key.PK !== item.PK || key.SK !== item.SK)) problems.push(`key should be ${key.PK}/${key.SK}`);
    for (const [attribute, value] of Object.entries(expectedIndexAttributes(entity, item))) {
      if (item[attribute] !== value) problems.push(`${attribute} should be ${value}`);
    }
    for (const attribute of CANONICAL_INSTANTS[entity] ?? []) {
      const value = item[attribute];
      if (typeof value === "string" && utcInstant(value) !== value) problems.push(`${attribute} should be the canonical UTC instant ${utcInstant(value)}`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "cannot derive the key");
  }
  return problems;
}
