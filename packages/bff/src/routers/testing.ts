// Test-only console world for the feature routers and the local UI server (tests/ui-server): the
// demo slice of connector/testing.ts (`firm-delta`, `imp-norpampa`, `sup-qingdao`, `op-4471`) with
// the firm rows, settings, paused clocks and broker rows of the fictitious personas of
// docs/seed-spec.md §4, and a caller that runs the real `appRouter` with a principal built on the
// server, so `firmProcedure` and friends run exactly as over HTTP. Nothing here ships in a Lambda.
import type { ConsoleRole } from "@legajo/shared";
import type { Principal } from "../auth/principal";
import { createTestIssuer, seedBrokers, testContextDeps } from "../auth/testing";
import type { MemoryStores } from "../connector/index";
import { CLOCK, FIRM, REAL_NOW, START_SIM, memoryStores, seedDemoSlice } from "../connector/testing";
import { createConsoleCaller } from "./index";
import { serverContext } from "./trpc";

const STAMP = { createdAt: REAL_NOW, updatedAt: REAL_NOW, version: 1, synthetic: true };

export const SUBS = {
  diego: "0b7f0e2e-0000-4000-8000-000000000001",
  martina: "0b7f0e2e-0000-4000-8000-000000000002",
  judge: "0b7f0e2e-0000-4000-8000-000000000003",
  pablo: "0b7f0e2e-0000-4000-8000-000000000004",
} as const;

export function principalOf(firmId: string, role: ConsoleRole, sub: string, brokerId: string, extra: Partial<Principal> = {}): Principal {
  return { sub, username: brokerId, firmId, role, groups: [role], isJudge: role === "JUDGE", authTime: Date.parse(REAL_NOW) / 1000, brokerId, ...extra };
}

export const DIEGO = principalOf(FIRM, "BROKER", SUBS.diego, "brk-delta-diego");
export const MARTINA = principalOf(FIRM, "ANALYST", SUBS.martina, "brk-delta-martina");
export const PABLO = principalOf("firm-norte", "BROKER", SUBS.pablo, "brk-norte-pablo");

function firmItem(firmId: string, name: string, kind: "DEMO" | "JUDGE" | "QA", clockId: string | undefined, mailbox: string) {
  return {
    ...STAMP,
    PK: `FIRM#${firmId}`,
    SK: "META",
    entity: "Firm",
    firmId,
    name,
    kind,
    mailboxAddress: mailbox,
    businessHours: { timezone: "America/Argentina/Buenos_Aires", from: "09:00", to: "18:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"] },
    ...(clockId === undefined ? {} : { clockId }),
    active: true,
  };
}

function settingsItem(firmId: string) {
  const label = "supuesto";
  return {
    ...STAMP,
    PK: `FIRM#${firmId}`,
    SK: "SETTINGS",
    entity: "FirmSettings",
    firmId,
    manualBaseline: { items: [{ action: "Contactos por legajo", count: 8, minutes: 8, label }], source: "Estimación propia del equipo", label },
    humanActionMinutes: { items: [{ action: "APPROVE", minutes: 10, label }], source: "Estimación propia del equipo", label },
    assumptions: { freeDaysAtPort: 5, demurrageUsdPerDay: { min: 160, max: 180 }, source: "Fuentes secundarias no verificadas", label },
    costBudgetUsdPerDossier: 5,
    turnCaps: { perHour: 200, perDay: 1000 },
  };
}

export interface ConsoleWorld {
  readonly stores: MemoryStores;
  /** The console as `principal` sees it. */
  caller(principal: Principal): ReturnType<typeof createConsoleCaller>;
}

/** Judge firm of the personas; its world exists only when asked for (`judgeWorld`). */
export const JUDGE_FIRM = "firm-judge-01";

async function createPausedClock(stores: MemoryStores, clockId: string, firmId: string): Promise<void> {
  await stores.connector.world.createClock({ clockId, firmId, mode: "PAUSED", offsetMs: 0, pausedSimNow: START_SIM, startAtSim: START_SIM, worldEpoch: 1, settings: { rateLimitPerHour: 20 } });
}

/**
 * Firms `firm-delta` (with the demo slice), `firm-norte` (empty) and `firm-qa`, their clocks and
 * brokers; with `judgeWorld`, also the judge firm with its world and its judge.
 */
export async function seedConsoleWorld(stores: MemoryStores, options: { readonly judgeWorld?: boolean } = {}): Promise<void> {
  await seedDemoSlice(stores);
  await stores.seed.loadItems("Firms", [
    firmItem(FIRM, "Estudio Delta", "DEMO", CLOCK, "estudio-delta@sim.legajo.demo.craftech.io"),
    settingsItem(FIRM),
    firmItem("firm-norte", "Estudio Norte", "DEMO", "GLOBAL#firm-norte", "estudio-norte@sim.legajo.demo.craftech.io"),
    settingsItem("firm-norte"),
    firmItem("firm-qa", "Estudio QA", "QA", undefined, "estudio-qa@sim.legajo.demo.craftech.io"),
    ...(options.judgeWorld ? [firmItem(JUDGE_FIRM, "Estudio Delta", "JUDGE", `JUDGE#${JUDGE_FIRM}`, "estudio-j01@sim.legajo.demo.craftech.io"), settingsItem(JUDGE_FIRM)] : []),
  ]);
  await createPausedClock(stores, CLOCK, FIRM);
  await createPausedClock(stores, "GLOBAL#firm-norte", "firm-norte");
  if (options.judgeWorld) await createPausedClock(stores, `JUDGE#${JUDGE_FIRM}`, JUDGE_FIRM);
  await seedBrokers(stores, [
    { firmId: FIRM, brokerId: "brk-delta-diego", role: "BROKER", sub: SUBS.diego, name: "Diego Ferreyra" },
    { firmId: FIRM, brokerId: "brk-delta-martina", role: "ANALYST", sub: SUBS.martina, name: "Martina Sosa" },
    { firmId: "firm-norte", brokerId: "brk-norte-pablo", role: "BROKER", sub: SUBS.pablo, name: "Pablo Giménez" },
    ...(options.judgeWorld ? [{ firmId: JUDGE_FIRM, brokerId: "brk-judge-01", role: "JUDGE" as const, sub: SUBS.judge, name: "Jurado 01" }] : []),
  ]);
}

/** The console world over the in-memory connector, with a caller per principal. */
export async function consoleWorld(options: { readonly now?: Date } = {}): Promise<ConsoleWorld> {
  const now = options.now ?? new Date(REAL_NOW);
  const stores = memoryStores();
  await seedConsoleWorld(stores);
  const deps = testContextDeps({ verifier: createTestIssuer().verifier(), stores, now: () => now });
  return { stores, caller: (principal) => createConsoleCaller(serverContext({ principal, deps })) };
}
