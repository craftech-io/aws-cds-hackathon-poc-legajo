// Who is who in each world of the seed (docs/seed-spec.md §3, §14): the demo worlds of Delta and Norte
// with the parties of §5-§6, the curated `guest` template with the placeholders the world factory
// replaces for each guest (`00` → `nn`), the fixed QA world `GLOBAL#firm-qa` of the `qa-min` template
// (clones with parties of their own) and the `models` the world factory clones from.
import type { WorldTemplateName } from "@legajo/shared";
import { DELTA_CLOCK, GUEST_TEMPLATE_CLOCK, GUEST_TEMPLATE_FIRM, GUEST_TEMPLATE_TAG, NORTE_CLOCK, QA_CLOCK } from "../lib/constants";
import { BROKERS, FIRMS, demoPhone, importerSpec, supplierSpec, type BrokerSpec, type FirmSpec, type ImporterSpec, type SupplierSpec } from "./catalog-parties";
import { GUEST_OPERATIONS, OPERATIONS, operationSpec, type OperationSpec } from "./catalog-operations";

export interface WorldImporter {
  readonly spec: ImporterSpec;
  readonly importerId: string;
  readonly phoneE164: string;
}

export interface WorldSupplier {
  readonly spec: SupplierSpec;
  readonly supplierId: string;
  readonly contactId: string;
  readonly contactEmail: string;
  readonly altContact?: string;
}

export interface WorldOperation {
  /** The model operation of the seed (its PDFs and ground truth: `templateOperation`). */
  readonly model: OperationSpec;
  readonly number: string;
  readonly operationId: string;
  readonly importer: WorldImporter;
  readonly supplier: WorldSupplier;
}

export interface WorldContext {
  readonly template: WorldTemplateName;
  readonly firm: FirmSpec;
  readonly clockId: string;
  readonly brokers: readonly BrokerSpec[];
  /** Who approved the historical dossiers and who resolved their escalations. */
  readonly approverId: string;
  readonly analystId: string;
  readonly operations: readonly WorldOperation[];
  readonly importers: readonly WorldImporter[];
  readonly suppliers: readonly WorldSupplier[];
  readonly authorizations: readonly { readonly importerId: string; readonly supplierId: string }[];
  /** The world owns its firm's rows (demo and guest worlds); a QA world lives in a shared firm. */
  readonly ownsFirm: boolean;
  /** Milestones, messages and decisions: every world but `models`, which only carries what a clone copies. */
  readonly withTimeline: boolean;
}

function firmSpec(firmId: string): FirmSpec {
  const found = FIRMS.find((firm) => firm.firmId === firmId);
  if (found === undefined) throw new RangeError(`unknown firm ${firmId}`);
  return found;
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}

/** A world whose parties keep the ids of the seed (demo worlds, guest template, models). */
function identityWorld(input: {
  template: WorldTemplateName;
  firm: FirmSpec;
  clockId: string;
  brokers: readonly BrokerSpec[];
  models: readonly OperationSpec[];
  phoneOf: (importer: ImporterSpec) => string;
  mailboxOf: (supplier: SupplierSpec) => { contactEmail: string; altContact?: string };
  ownsFirm: boolean;
  withTimeline: boolean;
}): WorldContext {
  const importers = uniqueBy(input.models.map((model) => importerSpec(model.importerId)), (spec) => spec.importerId).map((spec): WorldImporter => ({ spec, importerId: spec.importerId, phoneE164: input.phoneOf(spec) }));
  const suppliers = uniqueBy(input.models.map((model) => supplierSpec(model.supplierId)), (spec) => spec.supplierId).map((spec): WorldSupplier => ({ spec, supplierId: spec.supplierId, contactId: `ctc-${spec.code}-1`, ...input.mailboxOf(spec) }));
  const supplierIds = new Set(suppliers.map((supplier) => supplier.supplierId));
  const operations = input.models.map((model): WorldOperation => {
    const importer = importers.find((candidate) => candidate.importerId === model.importerId);
    const supplier = suppliers.find((candidate) => candidate.supplierId === model.supplierId);
    if (importer === undefined || supplier === undefined) throw new RangeError(`parties of ${model.number} missing`);
    return { model, number: model.number, operationId: `op-${model.number}`, importer, supplier };
  });
  const authorizations = importers.flatMap((importer) => importer.spec.authorizes.filter((supplierId) => supplierIds.has(supplierId)).map((supplierId) => ({ importerId: importer.importerId, supplierId })));
  const approver = input.brokers.find((broker) => broker.role !== "ANALYST") ?? input.brokers[0];
  const analyst = input.brokers.find((broker) => broker.role === "ANALYST") ?? approver;
  if (approver === undefined || analyst === undefined) throw new RangeError(`${input.template} has no broker`);
  return { template: input.template, firm: input.firm, clockId: input.clockId, brokers: input.brokers, approverId: approver.brokerId, analystId: analyst.brokerId, operations, importers, suppliers, authorizations, ownsFirm: input.ownsFirm, withTimeline: input.withTimeline };
}

const ownMailbox = (supplier: SupplierSpec) => ({ contactEmail: supplier.contactEmail, ...(supplier.altContact === undefined ? {} : { altContact: supplier.altContact }) });
const brokersOf = (firmId: string) => BROKERS.filter((broker) => broker.firmId === firmId);
const modelsOf = (firmId: string) => OPERATIONS.filter((operation) => operation.firmId === firmId);

export function deltaWorld(): WorldContext {
  return identityWorld({ template: "demo-firm-delta", firm: firmSpec("firm-delta"), clockId: DELTA_CLOCK, brokers: brokersOf("firm-delta"), models: modelsOf("firm-delta"), phoneOf: (importer) => demoPhone(importer.firmId, importer.phoneSuffix), mailboxOf: ownMailbox, ownsFirm: true, withTimeline: true });
}

export function norteWorld(): WorldContext {
  return identityWorld({ template: "demo-firm-norte", firm: firmSpec("firm-norte"), clockId: NORTE_CLOCK, brokers: brokersOf("firm-norte"), models: modelsOf("firm-norte"), phoneOf: (importer) => demoPhone(importer.firmId, importer.phoneSuffix), mailboxOf: ownMailbox, ownsFirm: true, withTimeline: true });
}

const SIM = "sim.legajo.demo.craftech.io";
const SES_SIMULATOR = "simulator.amazonses.com";

/** Guest `nn` mailbox of a supplier: `j<nn>-<code>@sim…`, or its own address at the SES mailbox simulator. */
function guestMailbox(supplier: SupplierSpec): { contactEmail: string; altContact?: string } {
  const simulated = supplier.contactEmail.endsWith(`@${SES_SIMULATOR}`);
  const contactEmail = simulated ? `${supplier.contactEmail.split("@")[0] ?? ""}+${GUEST_TEMPLATE_TAG}@${SES_SIMULATOR}` : `${GUEST_TEMPLATE_TAG}-${supplier.code}@${SIM}`;
  return { contactEmail, ...(supplier.altContact === undefined ? {} : { altContact: `${GUEST_TEMPLATE_TAG}-${supplier.code}-ops@${SIM}` }) };
}

/** The curated guest world with the `00` placeholders (firm, clock, broker, phones, mailboxes). */
export function guestWorld(): WorldContext {
  const firm: FirmSpec = { firmId: GUEST_TEMPLATE_FIRM, name: "Estudio Delta", kind: "GUEST", mailboxAddress: `estudio-${GUEST_TEMPLATE_TAG}@${SIM}`, clockId: GUEST_TEMPLATE_CLOCK, turnCaps: { perHour: 200, perDay: 1000 } };
  const guest: BrokerSpec = { brokerId: "brk-guest-00", firmId: GUEST_TEMPLATE_FIRM, name: "Invitado", role: "GUEST" };
  const models = GUEST_OPERATIONS.map((number) => ({ ...operationSpec(number), firmId: GUEST_TEMPLATE_FIRM }));
  return identityWorld({ template: "guest", firm, clockId: GUEST_TEMPLATE_CLOCK, brokers: [guest], models, phoneOf: (importer) => `+54911555100${importer.phoneSuffix}`, mailboxOf: guestMailbox, ownsFirm: true, withTimeline: true });
}

/** Operations of `GLOBAL#firm-qa` (numbers 7990-7994, kept out of the QA leases): key, number, model. */
export const QA_MIN_OPERATIONS: readonly { readonly key: string; readonly number: string; readonly model: string }[] = [
  { key: "a", number: "7990", model: "4471" },
  { key: "b", number: "7991", model: "4472" },
  { key: "c", number: "7992", model: "4487" },
  { key: "d", number: "7993", model: "4488" },
  { key: "e", number: "7994", model: "4489" },
];

/** Run id and scenario of the parties of the fixed QA world: `qa-firmqa-min-<key>-…` (invariant 20). */
export const QA_MIN_PREFIX = "qa-firmqa-min";

export function qaMinWorld(): WorldContext {
  const operations = QA_MIN_OPERATIONS.map(({ key, number, model: modelNumber }, index): WorldOperation => {
    const model = { ...operationSpec(modelNumber), firmId: "firm-qa" };
    const importerModel = importerSpec(model.importerId);
    const supplierModel = supplierSpec(model.supplierId);
    const importer: WorldImporter = { spec: importerModel, importerId: `imp-${QA_MIN_PREFIX}-${key}`, phoneE164: `+54911555099${90 + index}` };
    const supplier: WorldSupplier = { spec: supplierModel, supplierId: `sup-${QA_MIN_PREFIX}-${key}`, contactId: `ctc-${QA_MIN_PREFIX}-${key}-1`, contactEmail: `${QA_MIN_PREFIX}-${key}-${supplierModel.code}@${SIM}` };
    return { model, number, operationId: `op-${number}`, importer, supplier };
  });
  const authorizations = operations.filter((operation) => operation.importer.spec.authorizes.includes(operation.model.supplierId)).map((operation) => ({ importerId: operation.importer.importerId, supplierId: operation.supplier.supplierId }));
  return {
    template: "qa-min",
    firm: firmSpec("firm-qa"),
    clockId: QA_CLOCK,
    brokers: brokersOf("firm-qa"),
    approverId: "brk-qa-runner",
    analystId: "brk-qa-analyst",
    operations,
    importers: operations.map((operation) => operation.importer),
    suppliers: operations.map((operation) => operation.supplier),
    authorizations,
    ownsFirm: false,
    withTimeline: true,
  };
}

/** Every model operation with the parties of its firm; what `world.create` clones. */
export function modelsWorlds(): WorldContext[] {
  return [deltaWorld(), norteWorld()].map((world) => ({ ...world, template: "models" as const, ownsFirm: false, withTimeline: false }));
}

