// Worlds cloned from model operations (docs/seed-spec.md §14, docs/tool-catalog.md `world.create`):
// QA runs (`qa-<runId>-<scenario>` in `firm-qa`) and metrics batches (`sim-<batchId>` in `firm-sim`).
// Each entry `{key, model, importer, supplier}` clones one operation of `Seed/worlds/models.json`
// with its documents, versions and observations, under a number leased from 7000-7999
// (`Runtime/LEASE#OPNUM#<n>`), and gives it parties:
//
//   importer "own"   `imp-<clockId>-<key>` with a phone leased from `+54 9 11 5550 9xxx`
//                    (`LEASE#PHONE#<phone>`), its own `CONSENT#WHATSAPP` (unless `consent: NONE`) and
//                    `AUTH#` (only with `authorizations`)
//   supplier "own"   `sup-<clockId>-<key>` with the mailbox `<clockId>-<key>-<code>@sim…` (or
//                    `bounce+`/`complaint+<runId>-<scenario>-<key>@simulator.amazonses.com`), its
//                    alternative `<clockId>-<key>-<code>-ops@sim…` mapped when `altContacts` asks
//   "<key>"          the importer or supplier of that other entry, shared
//
// Milestones are computed from the clone's ETA (`etaOverride` or the model's); a dossier ready for
// review or approved skips them, a released one has them cancelled. The output is a template-shaped
// set of items the factory completes like any other (instantiate.ts).
import { MilestoneName, SES_MAILBOX_SIMULATOR_DOMAIN, SIM_MAIL_DOMAIN, ToolError, operationId as makeOperationId } from "@legajo/shared";
import { MILESTONE_SKIP } from "../milestones/dossier";
import { milestoneDueTimes } from "../milestones/schedule";
import type { TemplateItem, TemplateTable, WorldTemplate } from "./template";

export interface CloneEntry {
  readonly key: string;
  readonly model: string;
  readonly importer: string;
  readonly supplier: string;
  readonly etaOverride?: string;
  readonly authorizations: boolean;
  readonly consent: "GRANTED" | "NONE";
  readonly altContacts: boolean;
  readonly supplierOverride?: { readonly behaviour?: string; readonly delayHours?: number };
  readonly platformRow?: Readonly<Record<string, unknown>>;
}

export interface CloneTarget {
  readonly clockId: string;
  readonly firmId: string;
  /** Broker the seeded authorizations are recorded by (`brk-qa-runner`). */
  readonly brokerId: string;
  readonly entries: readonly CloneEntry[];
}

/** Takes a free number or phone (`acquireLease`); false when someone holds it. */
export type LeaseTaker = (kind: "PHONE" | "OPNUM", value: string) => Promise<boolean>;

export interface ClonedOperation {
  readonly key: string;
  readonly operationId: string;
  readonly operationNumber: string;
  readonly importerId: string;
  readonly supplierId: string;
  readonly contacts: ReadonlyArray<{ readonly contactId: string; readonly email: string; readonly status: string }>;
}

export interface ClonePlan {
  readonly items: Readonly<Record<TemplateTable, TemplateItem[]>>;
  readonly operations: readonly ClonedOperation[];
  readonly leases: ReadonlyArray<{ readonly kind: "PHONE" | "OPNUM"; readonly value: string }>;
}

export const CLONE_NUMBERS = { first: 7000, last: 7989 } as const;
/** `+54 9 11 5550 9000` to `9989`: `9990`-`9994` belong to `GLOBAL#firm-qa`. */
export const CLONE_PHONES = { prefix: "+5491155509", first: 0, last: 989 } as const;

const of = (items: readonly TemplateItem[], entity: string, field: string, value: string): TemplateItem[] => items.filter((item) => item.entity === entity && item[field] === value);

function one(items: readonly TemplateItem[], entity: string, field: string, value: string): TemplateItem {
  const found = of(items, entity, field, value)[0];
  if (found === undefined) throw new ToolError("INVALID", `the models have no ${entity} with ${field} ${value}`);
  return found;
}

/** `qa-812-sc16` → `812-sc16`: the `<runId>-<scenario>` of the simulator mailboxes. */
const runScenarioOf = (clockId: string): string => clockId.replace(/^(qa|sim)-/, "");

function mailboxOf(clockId: string, key: string, supplierId: string, modelEmail: string): string {
  const code = supplierId.replace(/^sup-/, "");
  const local = modelEmail.split("@")[0] ?? "";
  if (modelEmail.endsWith(`@${SES_MAILBOX_SIMULATOR_DOMAIN}`) && (local === "bounce" || local === "complaint")) return `${local}+${runScenarioOf(clockId)}-${key}@${SES_MAILBOX_SIMULATOR_DOMAIN}`;
  return `${clockId}-${key}-${code}@${SIM_MAIL_DOMAIN}`;
}

async function leaseFirst(take: LeaseTaker, kind: "PHONE" | "OPNUM", candidates: () => Generator<string>): Promise<string> {
  for (const value of candidates()) if (await take(kind, value)) return value;
  throw new ToolError("UNAVAILABLE", `no free ${kind === "PHONE" ? "phone" : "operation number"} left for a QA world`, "LEASES_EXHAUSTED");
}

function* numbers(): Generator<string> {
  for (let n = CLONE_NUMBERS.first; n <= CLONE_NUMBERS.last; n += 1) yield String(n);
}

function* phones(): Generator<string> {
  for (let n = CLONE_PHONES.first; n <= CLONE_PHONES.last; n += 1) yield `${CLONE_PHONES.prefix}${String(n).padStart(3, "0")}`;
}

interface Parties {
  importerId: string;
  supplierId: string;
  contacts: Array<{ contactId: string; email: string; status: string }>;
}

function milestoneTimers(operationId: string, eta: string, status: string, dispatch: string): TemplateItem[] {
  const due = milestoneDueTimes(eta);
  const closed = status === "READY_FOR_REVIEW" || status === "APPROVED";
  return MilestoneName.options.map((name) => ({
    entity: "Timer",
    kind: "MILESTONE",
    timerId: name,
    operationId,
    dueAtSim: new Date(Date.parse(due[name])).toISOString(),
    status: dispatch === "LIBERADO" ? "CANCELLED" : closed ? "SKIPPED" : "SCHEDULED",
    ...(dispatch === "LIBERADO" ? { reason: MILESTONE_SKIP.RELEASED } : closed ? { reason: MILESTONE_SKIP.COMPLETE } : {}),
    payload: {},
  }));
}

/** The items and leases of a cloned world; the leases are taken here, before anything is written. */
export async function planClones(models: WorldTemplate, target: CloneTarget, take: LeaseTaker): Promise<ClonePlan> {
  const all = (table: TemplateTable): readonly TemplateItem[] => models.items[table];
  const out: Record<TemplateTable, TemplateItem[]> = { Firms: [], Parties: [], Operations: [], Conversations: [], AuditLog: [], LegajoMetrics: [], Platform: [] };
  const leases: Array<{ kind: "PHONE" | "OPNUM"; value: string }> = [];
  const parties = new Map<string, Parties>();
  const operations: ClonedOperation[] = [];
  const world = { clockId: target.clockId, firmId: target.firmId };

  for (const entry of target.entries) {
    const model = one(all("Operations"), "Operation", "operationId", entry.model);
    const modelNumber = String(model.operationNumber);
    const number = await leaseFirst(take, "OPNUM", numbers);
    leases.push({ kind: "OPNUM", value: number });
    const opId = makeOperationId(number);
    const rename = (value: unknown): unknown => (typeof value === "string" ? value.replace(new RegExp(`^(dv|obs)-${modelNumber}-`), `$1-${number}-`) : value);

    // Parties: own, or those of an earlier entry.
    const sharedImporter = entry.importer === "own" ? undefined : parties.get(entry.importer);
    const sharedSupplier = entry.supplier === "own" ? undefined : parties.get(entry.supplier);
    if ((entry.importer !== "own" && sharedImporter === undefined) || (entry.supplier !== "own" && sharedSupplier === undefined)) throw new ToolError("INVALID", `entry ${entry.key} shares the parties of a later or unknown entry`);
    const own: Parties = { importerId: sharedImporter?.importerId ?? `imp-${target.clockId}-${entry.key}`, supplierId: sharedSupplier?.supplierId ?? `sup-${target.clockId}-${entry.key}`, contacts: sharedSupplier?.contacts ?? [] };
    parties.set(entry.key, own);

    if (sharedImporter === undefined) {
      const importer = one(all("Parties"), "Importer", "importerId", String(model.importerId));
      const phone = await leaseFirst(take, "PHONE", phones);
      leases.push({ kind: "PHONE", value: phone });
      out.Parties.push({ ...importer, ...world, importerId: own.importerId, phoneE164: phone });
      const consent = of(all("Parties"), "Consent", "importerId", String(model.importerId))[0] ?? of(all("Parties"), "Consent", "entity", "Consent")[0];
      if (entry.consent === "GRANTED" && consent !== undefined) out.Parties.push({ ...consent, ...world, importerId: own.importerId });
    }
    if (sharedSupplier === undefined) {
      const supplier = one(all("Parties"), "Supplier", "supplierId", String(model.supplierId));
      const override = entry.supplierOverride;
      const params = { ...((supplier.behaviourParams as Record<string, unknown> | undefined) ?? {}), ...(override?.delayHours === undefined ? {} : { delayHours: override.delayHours }) };
      out.Parties.push({ ...supplier, ...world, supplierId: own.supplierId, ...(override?.behaviour === undefined ? {} : { behaviour: override.behaviour }), behaviourParams: params });
      for (const [index, contact] of of(all("Parties"), "SupplierContact", "supplierId", String(model.supplierId)).entries()) {
        const contactId = `ctc-${target.clockId}-${entry.key}-${index + 1}`;
        const email = mailboxOf(target.clockId, entry.key, String(model.supplierId), String(contact.email));
        out.Parties.push({ ...contact, ...world, supplierId: own.supplierId, contactId, email });
        own.contacts.push({ contactId, email, status: String(contact.status) });
      }
      for (const profile of of(all("Parties"), "SupplierProfile", "supplierId", String(model.supplierId))) {
        out.Parties.push({ ...profile, ...world, supplierId: own.supplierId, ...(own.contacts[0] === undefined ? {} : { workingContactId: own.contacts[0].contactId }) });
      }
      if (entry.altContacts) {
        for (const alt of models.altContacts.filter((contact) => contact.supplierId === model.supplierId)) {
          const local = alt.email.split("@")[0] ?? "";
          const suffix = local.slice(local.lastIndexOf("-") + 1);
          own.contacts.push({ contactId: "", email: `${target.clockId}-${entry.key}-${String(model.supplierId).replace(/^sup-/, "")}-${suffix}@${SIM_MAIL_DOMAIN}`, status: "ALTERNATIVE" });
        }
      }
    }
    if (entry.authorizations && !out.Parties.some((item) => item.entity === "SupplierAuthorization" && item.importerId === own.importerId && item.supplierId === own.supplierId)) {
      const shape = of(all("Parties"), "SupplierAuthorization", "importerId", String(model.importerId))[0] ?? one(all("Parties"), "SupplierAuthorization", "entity", "SupplierAuthorization");
      const history = [{ action: "AUTHORIZED", atSim: shape.authorizedAt, by: `BROKER:${target.brokerId}` }];
      out.Parties.push({ ...shape, ...world, importerId: own.importerId, supplierId: own.supplierId, brokerId: target.brokerId, authorized: true, history });
    }

    // The operation, its documents, versions and observations, and its milestones.
    const eta = entry.etaOverride ?? String(model.eta);
    const etaHistory = (model.etaHistory as Array<Record<string, unknown>> | undefined)?.map((change, index) => (index === 0 ? { ...change, eta } : change));
    out.Operations.push({ ...model, ...world, operationId: opId, operationNumber: number, importerId: own.importerId, supplierId: own.supplierId, eta, ...(etaHistory === undefined ? {} : { etaHistory }), templateOperation: model.templateOperation ?? model.operationId });
    for (const entity of ["Document", "DocumentVersion", "Observation"]) {
      for (const item of of(all("Operations"), entity, "operationId", entry.model)) out.Operations.push(Object.fromEntries(Object.entries({ ...item, ...world, operationId: opId }).map(([field, value]) => [field, rename(value)])) as TemplateItem);
    }
    out.Operations.push(...milestoneTimers(opId, eta, String(model.dossierStatus), String((model.dispatch as { status?: string } | undefined)?.status ?? "NONE")));
    const platform = of(all("Platform"), "PlatformOperation", "operationNumber", modelNumber)[0];
    if (platform !== undefined) out.Platform.push({ ...platform, ...entry.platformRow, ...world, entity: "PlatformOperation", operationNumber: number, importerId: own.importerId, supplierId: own.supplierId, eta });
    operations.push({ key: entry.key, operationId: opId, operationNumber: number, importerId: own.importerId, supplierId: own.supplierId, contacts: own.contacts });
  }
  return { items: out, operations, leases };
}
