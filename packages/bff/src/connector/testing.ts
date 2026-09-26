// Fixtures for tests over the in-memory connector: a minimal slice of the demo world of
// docs/seed-spec.md (firm `firm-delta`, importer `imp-norpampa`, supplier `sup-qingdao`, operation
// `op-4471`) with the phone and email blocks the seed reserves. Hashes here are plain SHA-256 of the
// address: the stage uses HMAC subkeys (lib/crypto.ts), the connector only stores what it gets.
import { createHash } from "node:crypto";
import { threadAddress } from "@legajo/shared";
import type { NewEntity } from "../domain/common";
import type { Importer, Supplier } from "../domain/parties";
import { createMemoryStores, type MemoryStores } from "./memory/index";
import type { CreateOperationInput, NewContact } from "./ports";

export const CLOCK = "GLOBAL#firm-delta";
export const FIRM = "firm-delta";
/** Wednesday 14/10 10:30 in Buenos Aires: the start of the demo world. */
export const START_SIM = "2026-10-14T10:30:00-03:00";
export const REAL_NOW = "2026-09-26T15:00:00.000Z";

export const hashOf = (address: string): string => createHash("sha256").update(address).digest("hex");

export function memoryStores(): MemoryStores {
  return createMemoryStores({ now: () => new Date(REAL_NOW) });
}

export function importerFixture(overrides: Partial<NewEntity<typeof Importer>> = {}): NewEntity<typeof Importer> {
  const phoneE164 = overrides.phoneE164 ?? "+5491155500101";
  return {
    importerId: "imp-norpampa",
    firmId: FIRM,
    clockId: CLOCK,
    name: "Norpampa Insumos SRL",
    contactName: "Lucía Benítez",
    contactFirstName: "Lucía",
    phoneE164,
    phoneHash: hashOf(phoneE164),
    language: "es",
    ...overrides,
  };
}

export function supplierFixture(overrides: Partial<NewEntity<typeof Supplier>> = {}): NewEntity<typeof Supplier> {
  return {
    supplierId: "sup-qingdao",
    firmId: FIRM,
    clockId: CLOCK,
    name: "Qingdao Bluewave Textiles Co., Ltd.",
    country: "CN",
    timezone: "Asia/Shanghai",
    language: "en",
    behaviour: "SEEDED_ERROR",
    behaviourParams: {},
    ...overrides,
  };
}

export function contactFixture(overrides: Partial<NewContact> = {}): NewContact {
  const email = overrides.email ?? "supplier-qingdao@sim.legajo.demo.craftech.io";
  return {
    contactId: "ctc-qingdao-1",
    supplierId: "sup-qingdao",
    firmId: FIRM,
    clockId: CLOCK,
    email,
    emailHash: hashOf(email),
    status: "ACTIVE",
    confirmedBy: "SEED",
    confirmedAt: "2026-09-30T12:00:00-03:00",
    created: { atSim: "2026-09-30T12:00:00-03:00", by: "SEED" },
    ...overrides,
  };
}

export const THREAD_TAG = "k7p2q9";

export function operationFixture(overrides: Partial<CreateOperationInput> = {}): CreateOperationInput {
  const operationNumber = overrides.operationNumber ?? "4471";
  const threadTag = overrides.threadTag ?? THREAD_TAG;
  return {
    operationId: `op-${operationNumber}`,
    operationNumber,
    firmId: FIRM,
    clockId: CLOCK,
    worldEpoch: 1,
    importerId: "imp-norpampa",
    supplierId: "sup-qingdao",
    templateOperation: "op-4471",
    vessel: "Austral Aurora",
    carrier: "Austral Line",
    regime: "Importación para consumo",
    portOfLoading: "Qingdao",
    portOfDischarge: "Buenos Aires",
    eta: "2026-10-22T08:00:00-03:00",
    invoiceNumber: "QBT-2026-0917",
    incoterm: "FOB",
    incotermPlace: "Qingdao",
    dossierStatus: "OPEN",
    control: "AGENT",
    threadAddress: threadAddress(operationNumber, threadTag),
    threadTag,
    openedAtSim: START_SIM,
    created: { atSim: START_SIM, by: "SEED" },
    etaSource: "SEED",
    ...overrides,
  };
}

/** The demo slice: importer, supplier, its ACTIVE contact and operation 4471 with its thread claim. */
export async function seedDemoSlice(stores: MemoryStores): Promise<void> {
  const { parties, operations } = stores.connector;
  await parties.createImporter(importerFixture());
  await parties.createSupplier(supplierFixture());
  await parties.createContact(contactFixture());
  const operation = operationFixture();
  await operations.createOperation({ ...operation, threadClaimHash: hashOf(operation.threadAddress) });
}
