// Test-only worlds for the `QaDriver` over the in-memory connector: a scenario world `qa-812-1-sc01`
// (operation `op-7001`, importer `imp-qa-812-1-sc01-a`), the minimal QA world `GLOBAL#firm-qa` (`op-4471-qa`), the synthetic guest's
// world `GUEST#firm-guest-test` (`op-4471-jt`) and the demo slice of firm-delta (`op-4471`), plus a
// handler table whose every action only counts its calls. Nothing here ships in a Lambda.
import { GUEST_TEST_CLOCK_ID, QA_GLOBAL_CLOCK_ID, threadAddress } from "@legajo/shared";
import type { MemoryStores } from "../connector/index";
import { REAL_NOW, START_SIM, contactFixture, hashOf, importerFixture, memoryStores, operationFixture, seedDemoSlice, supplierFixture } from "../connector/testing";
import { createLogger } from "../lib/log";
import { QA_ACTIONS, type QaActionName } from "./contract";
import { type QaDriver, createQaDriver } from "./driver";
import type { ActionHandlers, QaPorts } from "./ports";

export const RUN_ID = "812-1";
export const QA_CLOCK = "qa-812-1-sc01";
export const OTHER_QA_CLOCK = "qa-812-1-sc02";

interface WorldSeed {
  readonly clockId: string;
  readonly firmId: string;
  readonly operationId: string;
  readonly operationNumber: string;
  readonly suffix: string;
  /** World-factory ids embed a `qa-*` world (`imp-qa-<runId>-<scenario>-<key>`). */
  readonly importerId: string;
  readonly phone: string;
}

export const QA_WORLDS: readonly WorldSeed[] = [
  { clockId: QA_CLOCK, firmId: "firm-qa", operationId: "op-7001", operationNumber: "7001", suffix: "sc01a", importerId: "imp-qa-812-1-sc01-a", phone: "+5491155590001" },
  { clockId: OTHER_QA_CLOCK, firmId: "firm-qa", operationId: "op-7002", operationNumber: "7002", suffix: "sc02a", importerId: "imp-qa-812-1-sc02-a", phone: "+5491155590002" },
  { clockId: QA_GLOBAL_CLOCK_ID, firmId: "firm-qa", operationId: "op-4471-qa", operationNumber: "4471", suffix: "qamin", importerId: "imp-qamin", phone: "+5491155590003" },
  { clockId: GUEST_TEST_CLOCK_ID, firmId: "firm-guest-test", operationId: "op-4471-jt", operationNumber: "4471", suffix: "jtest", importerId: "imp-jtest", phone: "+5491155590004" },
];

async function seedWorld(stores: MemoryStores, world: WorldSeed): Promise<void> {
  const { parties, operations, world: clocks } = stores.connector;
  const scope = { firmId: world.firmId, clockId: world.clockId };
  const { importerId } = world;
  const supplierId = `sup-${world.suffix}`;
  const email = `qa-${world.suffix}@sim.legajo.demo.craftech.io`;
  await clocks.createClock({ ...scope, mode: "PAUSED", offsetMs: 0, pausedSimNow: START_SIM, startAtSim: START_SIM, worldEpoch: 1, settings: { rateLimitPerHour: 20 } });
  await parties.createImporter(importerFixture({ ...scope, importerId, phoneE164: world.phone, phoneHash: hashOf(world.phone) }));
  await parties.createSupplier(supplierFixture({ ...scope, supplierId }));
  await parties.createContact(contactFixture({ ...scope, supplierId, contactId: `ctc-${world.suffix}-1`, email, emailHash: hashOf(email) }));
  const tag = "q7p2q9";
  const operation = operationFixture({ ...scope, operationId: world.operationId, operationNumber: world.operationNumber, importerId, supplierId, threadTag: tag, threadAddress: threadAddress(world.operationNumber, tag) });
  await operations.createOperation({ ...operation, threadClaimHash: hashOf(`${operation.threadAddress}#${world.clockId}`) });
}

const STAMP = { createdAt: REAL_NOW, updatedAt: REAL_NOW, version: 1, synthetic: true };

function firmRows(firmId: string, name: string) {
  const label = "supuesto";
  const hours = { timezone: "America/Argentina/Buenos_Aires", from: "09:00", to: "18:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"] };
  return [
    { ...STAMP, PK: `FIRM#${firmId}`, SK: "META", entity: "Firm", firmId, name, kind: "QA", mailboxAddress: `estudio-${firmId}@sim.legajo.demo.craftech.io`, businessHours: hours, active: true },
    {
      ...STAMP,
      PK: `FIRM#${firmId}`,
      SK: "SETTINGS",
      entity: "FirmSettings",
      firmId,
      manualBaseline: { items: [{ action: "Contactos por legajo", count: 8, minutes: 8, label }], source: "Estimación propia del equipo", label },
      humanActionMinutes: { items: [{ action: "APPROVE", minutes: 10, label }], source: "Estimación propia del equipo", label },
      assumptions: { freeDaysAtPort: 5, demurrageUsdPerDay: { min: 160, max: 180 }, source: "Fuentes secundarias no verificadas", label },
      costBudgetUsdPerDossier: 5,
      turnCaps: { perHour: 400, perDay: 2000 },
    },
  ];
}

/** The demo slice of firm-delta and the four QA worlds, over one in-memory connector. */
export async function qaDriverStores(): Promise<MemoryStores> {
  const stores = memoryStores();
  await seedDemoSlice(stores);
  await stores.seed.loadItems("Firms", [...firmRows("firm-qa", "Estudio QA"), ...firmRows("firm-guest-test", "Estudio de prueba")]);
  for (const world of QA_WORLDS) await seedWorld(stores, world);
  return stores;
}

/** Every action answers `{ action, call }` and counts its calls. */
export function countingHandlers(): { readonly handlers: ActionHandlers; readonly calls: Map<QaActionName, number> } {
  const calls = new Map<QaActionName, number>();
  const entries = QA_ACTIONS.map((action) => [
    action,
    async () => {
      const call = (calls.get(action) ?? 0) + 1;
      calls.set(action, call);
      return { action, call };
    },
  ]);
  return { handlers: Object.fromEntries(entries) as unknown as ActionHandlers, calls };
}

export interface DriverUnderTest {
  readonly driver: QaDriver;
  readonly stores: MemoryStores;
  readonly lines: string[];
}

export async function driverUnderTest(handlers: ActionHandlers, stores?: MemoryStores): Promise<DriverUnderTest> {
  const world = stores ?? (await qaDriverStores());
  const lines: string[] = [];
  // Waiting moves this fake clock forward, so polling actions reach their deadline at once.
  let at = Date.parse(REAL_NOW);
  const now = () => new Date(at);
  const driver = createQaDriver({
    data: world.connector,
    handlers,
    now,
    sleep: (ms) => Promise.resolve(void (at += ms)),
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", now, sink: (line) => void lines.push(line) }),
  });
  return { driver, stores: world, lines };
}

export const key = (step: number, label?: string): string => `${RUN_ID}/sc01/${step}${label === undefined ? "" : `/${label}`}`;

/** Ports whose every call fails: a test that reaches one drives a module it did not wire. */
export function refusingPorts(): QaPorts {
  const off = (what: string) => () => Promise.reject(new Error(`${what} is not part of this test`));
  return {
    worlds: { create: off("world.create"), destroy: off("world.destroy") },
    clock: { advance: off("clock.advance"), fireMilestone: off("clock.fireMilestone"), unfreeze: off("clock.unfreeze"), freeze: off("clock.freeze") },
    channels: { whatsappInbound: off("wa.inbound"), injectEmail: off("email.inject"), redeliverEmail: off("email.redeliver") },
    simMail: { sendNow: off("supplier.sendNow") },
    worker: { poison: off("event.poison"), forceNextTurnFailure: off("turn.forceFailure"), healthProbe: off("probe.mocks"), fireStale: off("schedule.fireStale") },
    fence: { probe: off("fence.probe") },
    batch: { run: off("batch.run") },
  };
}
