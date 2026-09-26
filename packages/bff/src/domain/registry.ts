// One entry per entity: the table it lives in and its zod schema. The connector validates what it
// reads and writes with these, and the seed loader and `seed:validate` (WP-08, WP-31) validate every
// seeded item with the same schema (docs/seed-spec.md §16), so the seed can never drift from the code.
import type { z } from "zod";
import type { TableName } from "../lib/resource";
import { Decision } from "./audit";
import { EntityName } from "./common";
import { Message, MailboxMessage, MessageEvent, TurnNote } from "./conversations";
import { Document, DocumentVersion, Observation } from "./documents";
import { Broker, Checklist, Firm, FirmSettings, ResponsibilityMatrix } from "./firms";
import { DossierKpi } from "./metrics";
import { Escalation, Operation } from "./operations";
import { AddressClaim, Consent, Importer, Supplier, SupplierAuthorization, SupplierContact, SupplierProfile } from "./parties";
import { DispatchGlossary, EvalTruth, Holiday, NameCheck, ObservationCodeLabel, RateCard, Template } from "./reference";
import { Counter, Idempotency, MailProbe, Nonce, Probe, RateCounter, Session, Turn, TurnCap, TurnResult, UploadLink } from "./runtime";
import { Timer } from "./timers";
import { Clock, Lease, MailPending, OpState, ScanPending, Tombstone, WorldState } from "./world-state";

export interface EntitySpec {
  readonly table: TableName;
  readonly schema: z.ZodType<unknown>;
}

const spec = (table: TableName, schema: z.ZodType<unknown>): EntitySpec => ({ table, schema });

export const ENTITIES: Readonly<Record<EntityName, EntitySpec>> = {
  Firm: spec("Firms", Firm),
  FirmSettings: spec("Firms", FirmSettings),
  Broker: spec("Firms", Broker),
  Checklist: spec("Firms", Checklist),
  ResponsibilityMatrix: spec("Firms", ResponsibilityMatrix),
  Importer: spec("Parties", Importer),
  Consent: spec("Parties", Consent),
  SupplierAuthorization: spec("Parties", SupplierAuthorization),
  Supplier: spec("Parties", Supplier),
  SupplierContact: spec("Parties", SupplierContact),
  SupplierProfile: spec("Parties", SupplierProfile),
  AddressClaim: spec("Parties", AddressClaim),
  Operation: spec("Operations", Operation),
  Document: spec("Operations", Document),
  DocumentVersion: spec("Operations", DocumentVersion),
  Observation: spec("Operations", Observation),
  Escalation: spec("Operations", Escalation),
  Timer: spec("Operations", Timer),
  Message: spec("Conversations", Message),
  MessageEvent: spec("Conversations", MessageEvent),
  TurnNote: spec("Conversations", TurnNote),
  MailboxMessage: spec("Conversations", MailboxMessage),
  Decision: spec("AuditLog", Decision),
  Holiday: spec("Reference", Holiday),
  Template: spec("Reference", Template),
  RateCard: spec("Reference", RateCard),
  DispatchGlossary: spec("Reference", DispatchGlossary),
  ObservationCode: spec("Reference", ObservationCodeLabel),
  EvalTruth: spec("Reference", EvalTruth),
  NameCheck: spec("Reference", NameCheck),
  Session: spec("Runtime", Session),
  Turn: spec("Runtime", Turn),
  TurnResult: spec("Runtime", TurnResult),
  Nonce: spec("Runtime", Nonce),
  UploadLink: spec("Runtime", UploadLink),
  Clock: spec("Runtime", Clock),
  Idempotency: spec("Runtime", Idempotency),
  RateCounter: spec("Runtime", RateCounter),
  TurnCap: spec("Runtime", TurnCap),
  Counter: spec("Runtime", Counter),
  OpState: spec("Runtime", OpState),
  WorldState: spec("Runtime", WorldState),
  MailPending: spec("Runtime", MailPending),
  ScanPending: spec("Runtime", ScanPending),
  Lease: spec("Runtime", Lease),
  Tombstone: spec("Runtime", Tombstone),
  Probe: spec("Runtime", Probe),
  MailProbe: spec("Runtime", MailProbe),
  DossierKpi: spec("LegajoMetrics", DossierKpi),
};

/** Entities a table holds (the seed loader refuses an item whose `entity` belongs elsewhere). */
export function entitiesOf(table: TableName): EntityName[] {
  return EntityName.options.filter((name) => ENTITIES[name].table === table);
}

export type EntityCheck = { readonly ok: true; readonly entity: EntityName } | { readonly ok: false; readonly error: string };

/** Validates a stored or seeded item by its `entity` discriminator and the table it goes to. */
export function checkEntityItem(table: TableName, item: Readonly<Record<string, unknown>>): EntityCheck {
  const entity = EntityName.safeParse(item.entity);
  if (!entity.success) return { ok: false, error: `unknown entity ${JSON.stringify(item.entity)}` };
  const target = ENTITIES[entity.data];
  if (target.table !== table) return { ok: false, error: `${entity.data} belongs to ${target.table}, not ${table}` };
  const parsed = target.schema.safeParse(item);
  if (!parsed.success) return { ok: false, error: `${entity.data}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}` };
  return { ok: true, entity: entity.data };
}
