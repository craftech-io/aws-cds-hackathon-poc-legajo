// `seed:load` over memory (docs/seed-spec.md §3, §15 invariant 19 and §16): the first load creates the
// demo worlds at epoch 1 with their clocks paused and fills the `Seed` bucket; the same fingerprint is a
// no-op; a reload is a reset, never epoch 1 again: two reloads leave each demo clock at epoch 3, with
// thread addresses and actors distinct from epochs 1 and 2, a tombstone per past epoch, no Memory left
// for the old actors, the brokers' Cognito binding kept and the operator's phone override applied.
import { beforeEach, describe, expect, it } from "vitest";
import { seedKeys } from "@legajo/shared";
import { brokerKey } from "@legajo/bff/connector/keys";
import { SeedOverrides } from "@legajo/bff/lib/secrets";
import { actorIdOf } from "@legajo/bff/turns/identity";
import { purgeRemainingPasses } from "@legajo/bff/worlds/memory-purge";
import { type WorldsHarness, worldsHarness } from "@legajo/bff/worlds/testing";
import { readSeed } from "../lib/files";
import { LOADED_KEY, parseLoadArgs } from "../load/plan";
import { type LoadPorts, type SeedBucket, runLoad } from "../load/run";

const seed = readSeed();
const NO_OVERRIDES = SeedOverrides.parse({});
const DEMO_CLOCKS = ["GLOBAL#firm-delta", "GLOBAL#firm-norte", "GLOBAL#firm-qa"];

let h: WorldsHarness;
let objects: Map<string, Uint8Array>;

function bucket(): SeedBucket {
  return {
    put: async (key, body) => void objects.set(key, body),
    getText: async (key) => (objects.has(key) ? new TextDecoder().decode(objects.get(key)) : undefined),
  };
}

function ports(overrides = NO_OVERRIDES): LoadPorts {
  const purge = { memory: h.memory, data: h.stores.connector, log: h.deps.log, now: () => h.realNow, sleep: async (ms: number) => void (h.realNow = new Date(h.realNow.getTime() + ms)) };
  return {
    bucket: bucket(),
    worlds: { ...h.deps, continuePurge: async (target) => void (await purgeRemainingPasses(purge, target)) },
    overrides,
    report: () => undefined,
  };
}

const operation = (id: string) => h.stores.connector.operations.getOperation(id);

beforeEach(() => {
  h = worldsHarness();
  objects = new Map();
});

describe("seed:load", () => {
  it("creates the demo worlds at epoch 1, paused, fills the bucket and loads the static rows; the same fingerprint is a no-op", async () => {
    const first = await runLoad(seed, parseLoadArgs([]), ports());
    expect(first.worlds.map((world) => [world.clockId, world.action, world.worldEpoch])).toEqual(DEMO_CLOCKS.map((clockId) => [clockId, "CREATED", 1]));
    for (const clockId of DEMO_CLOCKS) expect(await h.stores.connector.world.getClock(clockId)).toMatchObject({ mode: "PAUSED", worldEpoch: 1 });
    expect(objects.has(seedKeys.worldTemplate("guest"))).toBe(true);
    expect(objects.has(seedKeys.pdf("op-4471", "PACKING_LIST", 2))).toBe(true);
    expect(objects.has(seedKeys.unknownPdf(1))).toBe(true);
    expect(objects.has(seedKeys.readerCatalog)).toBe(true);
    expect(objects.has(LOADED_KEY)).toBe(true);
    expect(await h.stores.connector.firms.getBroker("firm-qa", "brk-qa-runner")).toMatchObject({ role: "BROKER" });
    expect(h.stores.client.dump("ReaderCatalog")).toHaveLength(seed.tables.ReaderCatalog.items.length);
    expect((await h.stores.connector.audit.listByDecision("firm-delta", "ACTION")).some((row) => row.action === "SEED_LOADED")).toBe(true);

    const again = await runLoad(seed, parseLoadArgs([]), ports());
    expect(again).toMatchObject({ skipped: true, fingerprint: first.fingerprint });
    expect(await h.stores.connector.world.currentEpoch("GLOBAL#firm-delta")).toBe(1);
  });

  it("[FL-087] two reloads leave every demo clock at epoch 3 with new addresses and actors, tombstones, no old Memory, bindings kept", async () => {
    await runLoad(seed, parseLoadArgs([]), ports());
    const epoch1 = await operation("op-4471");
    await h.stores.connector.firms.setBrokerCognitoSub("firm-delta", "brk-delta-diego", "sub-diego");
    await h.stores.connector.firms.setBrokerCognitoSub("firm-qa", "brk-qa-runner", "sub-runner");
    h.memory.events.set(`${actorIdOf(epoch1.importerId, 1)}/session-1`, ["evt-1"]);

    expect((await runLoad(seed, parseLoadArgs(["--force"]), ports())).worlds.every((world) => world.action === "RESET" && world.worldEpoch === 2)).toBe(true);
    const epoch2 = await operation("op-4471");
    h.memory.events.set(`${actorIdOf(epoch2.importerId, 2)}/session-2`, ["evt-2"]);
    h.memory.records.set(`/importers/${actorIdOf(epoch2.importerId, 2)}/facts/`, ["rec-2"]);

    // Different overrides, different fingerprint: a reload without --force.
    const overrides = SeedOverrides.parse({ importerPhones: { "imp-norpampa": "+5491155500199" } });
    const third = await runLoad(seed, parseLoadArgs([]), ports(overrides));
    expect(third.worlds.map((world) => world.worldEpoch)).toEqual([3, 3, 3]);
    const epoch3 = await operation("op-4471");
    expect(new Set([epoch1.threadAddress, epoch2.threadAddress, epoch3.threadAddress]).size).toBe(3);
    expect(new Set([1, 2, 3].map((epoch) => actorIdOf(epoch3.importerId, epoch))).size).toBe(3);
    for (const clockId of DEMO_CLOCKS) {
      expect(await h.stores.connector.world.isTombstoned(clockId, 1)).toBe(true);
      expect(await h.stores.connector.world.isTombstoned(clockId, 2)).toBe(true);
      expect((await h.stores.connector.world.getClock(clockId)).worldEpoch).toBe(3);
    }
    expect(h.memory.remaining()).toBe(0);
    expect(await h.stores.client.get("Firms", brokerKey("firm-delta", "brk-delta-diego"))).toMatchObject({ cognitoSub: "sub-diego", cognitoSubKey: "SUB#sub-diego" });
    expect(await h.stores.client.get("Firms", brokerKey("firm-qa", "brk-qa-runner"))).toMatchObject({ cognitoSub: "sub-runner" });
    expect((await h.stores.connector.parties.findImporter("imp-norpampa"))?.phoneE164).toBe("+5491155500199");
  });

  it("--firm limits the load to one firm's rows and world; flags are checked", async () => {
    const result = await runLoad(seed, parseLoadArgs(["--firm", "firm-norte"]), ports());
    expect(result.worlds.map((world) => world.clockId)).toEqual(["GLOBAL#firm-norte"]);
    expect(await h.stores.connector.world.findClock("GLOBAL#firm-delta")).toBeUndefined();
    expect(() => parseLoadArgs(["--firm", "firm-guest-03"])).toThrow(RangeError);
    expect(() => parseLoadArgs(["--forse"])).toThrow(RangeError);
  });
});
