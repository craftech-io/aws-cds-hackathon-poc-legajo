// Stand-in of `account.ensureWorld` and `account.world` for the local UI server (docs/build-plan.md
// WP-49: the real procedures arrive with WP-31; until then the UI server answers them). Same contract
// (packages/shared/src/signup.ts) and the same observable behaviour of ADR-0015 §4: one lease per
// account, `CREATING` answered at once, `CAPACITY` without creating anything when the public slots are
// full (a switch the specs flip), `EXPIRED` after the world was destroyed, whose broker row goes first
// so the owner's tokens are refused (`GUEST_WORLD_GONE`).
//
// The world factory (WP-31) does not exist yet, so a world is never built: the lease answers `CREATING`
// and, a moment later, `account.world` answers `FAILED`, the honest state the stage gives today
// (`WorldJanitor` cannot run `GUEST_CREATE`) and that /welcome shows as "No pudimos preparar tu mundo"
// (docs/landing-spec.md §8.0 and §8.5). Never a `READY` world without the seeded content /welcome
// promises. A spec that only checks the welcome mechanics (READY, the console opening, EXPIRED) flips
// `mechanicsOnly` for its own account: that world is a firm, its paused clock and the guest's broker row
// bound to the `sub` and the lease, with no operation, never used for captures. Nothing here ships in a
// Lambda.
import { randomUUID } from "node:crypto";
import type { MemoryStores } from "@legajo/bff/connector/index";
import { guestBootstrapProcedure, router } from "@legajo/bff/routers/trpc";
import type { EnsureWorldOutput, GuestWorldState } from "@legajo/shared/signup";

const START_SIM = "2026-10-14T13:30:00.000Z";
/** First public slot (ADR-0015 §4: `31–90`). */
const FIRST_PUBLIC_SLOT = 31;

interface WorldRecord {
  state: "CREATING" | "READY" | "FAILED" | "FAILED_CAPACITY" | "DESTROYED";
  readonly leaseId: string;
  readonly nn: number;
  readonly since: string;
}

export interface GuestWorldControl {
  /** The 60 public slots are leased: `ensureWorld` answers `CAPACITY` and creates nothing. */
  capacityFull: boolean;
  /** The same, for these accounts (`sub`) only: specs running side by side do not see each other's switch. */
  readonly fullFor: Set<string>;
  /**
   * Accounts (`sub`) whose world is the mechanics-only one (firm, clock and broker row, no operation),
   * for the specs of the welcome mechanics; every other account gets `FAILED` until WP-31.
   */
  readonly mechanicsOnly: Set<string>;
  /** How long a world takes to be ready (or to fail) after `ensureWorld`. */
  createDelayMs: number;
  /** Calls of `account.ensureWorld` so far (a spec asserts there is one per visit). */
  ensureCalls: number;
}

export interface GuestWorlds {
  readonly control: GuestWorldControl;
  readonly router: ReturnType<typeof guestWorldRouter>;
  /** Destroys the world of `sub` as the hourly sweep would: broker row first, then the state. */
  expire(sub: string): Promise<boolean>;
}

const STAMP = (at: string) => ({ createdAt: at, updatedAt: at, version: 1, synthetic: true });

function firmIdOf(nn: number): string {
  return `firm-guest-${String(nn).padStart(2, "0")}`;
}

async function createWorld(stores: MemoryStores, sub: string, nn: number, leaseId: string, at: string): Promise<void> {
  const firmId = firmIdOf(nn);
  const clockId = `GUEST#${firmId}`;
  const code = String(nn).padStart(2, "0");
  await stores.seed.loadItems("Firms", [
    {
      ...STAMP(at),
      PK: `FIRM#${firmId}`,
      SK: "META",
      entity: "Firm",
      firmId,
      name: "Estudio Delta",
      kind: "GUEST",
      guestKind: "PUBLIC",
      mailboxAddress: `estudio-g${code}@sim.legajo.demo.craftech.io`,
      businessHours: { timezone: "America/Argentina/Buenos_Aires", from: "09:00", to: "18:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"] },
      clockId,
      active: true,
    },
    {
      ...STAMP(at),
      PK: `FIRM#${firmId}`,
      SK: `BROKER#brk-guest-${code}`,
      entity: "Broker",
      brokerId: `brk-guest-${code}`,
      firmId,
      name: "Invitado",
      role: "GUEST",
      active: true,
      cognitoSub: sub,
      cognitoSubKey: `SUB#${sub}`,
      leaseId,
    },
  ]);
  await stores.connector.world.createClock({ clockId, firmId, mode: "PAUSED", offsetMs: 0, pausedSimNow: START_SIM, startAtSim: START_SIM, worldEpoch: 1, settings: { rateLimitPerHour: 20 } });
}

function stateOf(record: WorldRecord | undefined): GuestWorldState {
  if (record === undefined) return "NONE";
  if (record.state === "FAILED_CAPACITY") return "CAPACITY";
  if (record.state === "FAILED") return "FAILED";
  if (record.state === "DESTROYED") return "EXPIRED";
  return record.state;
}

function guestWorldRouter(stores: MemoryStores, control: GuestWorldControl, records: Map<string, WorldRecord>, now: () => Date) {
  let nextSlot = FIRST_PUBLIC_SLOT;
  return router({
    ensureWorld: guestBootstrapProcedure.mutation(async ({ ctx }): Promise<EnsureWorldOutput> => {
      control.ensureCalls += 1;
      const { sub } = ctx.guest;
      const current = records.get(sub);
      if (current?.state === "READY") return { state: "READY", firmId: firmIdOf(current.nn), clockId: `GUEST#${firmIdOf(current.nn)}` };
      if (current?.state === "CREATING") return { state: "CREATING" };
      // FAILED, EXPIRED or CAPACITY: a new lease, as the BFF retries.
      const since = now().toISOString();
      if (control.capacityFull || control.fullFor.has(sub)) {
        records.set(sub, { state: "FAILED_CAPACITY", leaseId: randomUUID(), nn: 0, since });
        return { state: "CAPACITY" };
      }
      const record: WorldRecord = { state: "CREATING", leaseId: randomUUID(), nn: nextSlot, since };
      nextSlot += 1;
      records.set(sub, record);
      const mechanicsOnly = control.mechanicsOnly.has(sub);
      setTimeout(() => {
        if (!mechanicsOnly) {
          // No world factory yet (WP-31): the world is not built, and the state says so.
          if (records.get(sub) === record) record.state = "FAILED";
          return;
        }
        void createWorld(stores, sub, record.nn, record.leaseId, now().toISOString()).then(() => {
          if (records.get(sub) === record) record.state = "READY";
        });
      }, control.createDelayMs);
      return { state: "CREATING" };
    }),
    world: guestBootstrapProcedure.query(({ ctx }) => {
      const record = records.get(ctx.guest.sub);
      const state = stateOf(record);
      return state === "READY" && record ? { state, firmId: firmIdOf(record.nn), clockId: `GUEST#${firmIdOf(record.nn)}`, since: record.since } : { state };
    }),
  });
}

export function createGuestWorlds(stores: MemoryStores, now: () => Date): GuestWorlds {
  const control: GuestWorldControl = { capacityFull: false, fullFor: new Set(), mechanicsOnly: new Set(), createDelayMs: 1_500, ensureCalls: 0 };
  const records = new Map<string, WorldRecord>();
  return {
    control,
    router: guestWorldRouter(stores, control, records, now),
    async expire(sub) {
      const record = records.get(sub);
      if (record?.state !== "READY") return false;
      const firmId = firmIdOf(record.nn);
      await stores.client.delete("Firms", { PK: `FIRM#${firmId}`, SK: `BROKER#brk-guest-${String(record.nn).padStart(2, "0")}` });
      record.state = "DESTROYED";
      return true;
    },
  };
}
