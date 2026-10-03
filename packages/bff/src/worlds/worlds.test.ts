// The world factory (docs/seed-spec.md §14, docs/architecture.md §8, FL-086, FL-087): idempotent
// creation, collisions on `ADDR#`, leftovers of a creation that fell over, the tombstone and the epoch
// of a destroy, demo worlds never destroyed, clones of one model operation, guest worlds with distinct
// addresses, and a reset that rebuilds the world from its template at a new epoch.
import { describe, expect, it } from "vitest";
import { ToolError, parseThreadAddress } from "@legajo/shared";
import { resetWorld } from "../clock/reset";
import { addressClaimKey, brokerKey } from "../connector/keys";
import type { CloneEntry } from "./clones";
import { destroyWorld } from "./destroy";
import { createWorld } from "./factory";
import { addressHashOf } from "./instantiate";
import type { WorldRequest } from "./plan";
import { resetDepsOf } from "./rebuild";
import { worldsHarness } from "./testing";

const START = "2026-10-14T10:30:00-03:00";

function entry(key: string, model: string, overrides: Partial<CloneEntry> = {}): CloneEntry {
  return { key, model, importer: "own", supplier: "own", authorizations: true, consent: "GRANTED", altContacts: false, ...overrides };
}

const qa = (scenario: string, entries: readonly CloneEntry[]): WorldRequest => ({ kind: "QA", runId: "812", scenario, startAtSim: START, entries });

async function rejection(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("[FL-086] createWorld", () => {
  it("writes a demo world at epoch 1 with its clock PAUSED at the start, and answers it again without writing", async () => {
    const h = worldsHarness();
    const created = await createWorld({ kind: "DEMO", template: "demo-firm-delta" }, h.deps);
    expect(created).toMatchObject({ clockId: "GLOBAL#firm-delta", firmId: "firm-delta", worldEpoch: 1, created: true });
    expect(created.operations).toHaveLength(24);
    const clock = await h.stores.connector.world.getClock("GLOBAL#firm-delta");
    expect(clock).toMatchObject({ mode: "PAUSED", worldEpoch: 1, template: "demo-firm-delta" });
    expect(Date.parse(clock.pausedSimNow)).toBe(Date.parse(START));
    const operation = await h.stores.connector.operations.getOperation("op-4471");
    expect(await h.stores.client.get("Parties", addressClaimKey(addressHashOf(h.deps.keys, operation.threadAddress)))).toMatchObject({ ownerId: "op-4471", kind: "THREAD" });
    expect(await h.stores.client.get("Platform", { PK: "POP#firm-delta#4471", SK: "META" })).toMatchObject({ eta: "2026-10-22T08:00:00-03:00", clockId: "GLOBAL#firm-delta" });

    const again = await createWorld({ kind: "DEMO", template: "demo-firm-delta" }, h.deps);
    expect(again).toMatchObject({ created: false, worldEpoch: 1 });
    expect(await h.stores.connector.world.currentEpoch("GLOBAL#firm-delta")).toBe(1);
  });

  it("refuses with CONFLICT when an address is claimed by another world, and writes nothing", async () => {
    const h = worldsHarness();
    await createWorld({ kind: "GUEST", firmId: "firm-guest-05" }, h.deps);
    // The supplier mailbox of slot 05 taken by someone else before slot 05's next world.
    const mailbox = "g07-qingdao@sim.legajo.demo.craftech.io";
    await h.stores.client.put("Parties", { ...addressClaimKey(addressHashOf(h.deps.keys, mailbox)), entity: "AddressClaim", ownerId: "ctc-other-1", firmId: "firm-delta" });
    const refused = await rejection(createWorld({ kind: "GUEST", firmId: "firm-guest-07" }, h.deps));
    expect(refused).toMatchObject({ code: "CONFLICT", reason: "ADDRESS_TAKEN" });
    expect(await h.stores.connector.world.findClock("GUEST#firm-guest-07")).toBeUndefined();
    expect(await h.stores.connector.operations.findOperation("op-4471-g07")).toBeUndefined();
    const g07Claims = h.stores.client.dump("Parties").filter((row) => row.clockId === "GUEST#firm-guest-07");
    expect(g07Claims).toEqual([]);
  });

  it("deletes the leftovers of a creation that fell over, and the next one starts at a higher epoch", async () => {
    const h = worldsHarness();
    const load = h.deps.seed.loadItems.bind(h.deps.seed);
    let failed = false;
    const deps = {
      ...h.deps,
      seed: {
        ...h.deps.seed,
        loadItems: async (table: Parameters<typeof load>[0], items: Parameters<typeof load>[1]) => {
          if (table === "Conversations" && !failed) {
            failed = true;
            throw new Error("throttled");
          }
          return load(table, items);
        },
      },
    };
    await expect(createWorld({ kind: "GUEST", firmId: "firm-guest-02" }, deps)).rejects.toThrow("throttled");
    const leftover = await h.stores.connector.operations.getOperation("op-4471-g02");
    expect(await h.stores.connector.world.findClock("GUEST#firm-guest-02")).toBeUndefined();

    const created = await createWorld({ kind: "GUEST", firmId: "firm-guest-02" }, deps);
    expect(created.worldEpoch).toBe(2);
    const operation = await h.stores.connector.operations.getOperation("op-4471-g02");
    expect(operation.threadAddress).not.toBe(leftover.threadAddress);
    // The model operation names the seed's PDFs (`Seed/pdfs/op-4471/…`): it is never renamed for the world.
    expect(operation.templateOperation).toBe("op-4471");
    expect(await h.stores.client.get("Parties", addressClaimKey(addressHashOf(h.deps.keys, leftover.threadAddress)))).toBeUndefined();
  });

  it("[FL-087] clones one model operation twice in a QA world: separate parties, no ADDR# collision, independent consent", async () => {
    const h = worldsHarness();
    const world = await createWorld(qa("sc05", [entry("a", "op-4474"), entry("b", "op-4474")]), h.deps);
    const [a, b] = world.operations;
    expect(a?.importerId).toBe("imp-qa-812-sc05-a");
    expect(b?.importerId).toBe("imp-qa-812-sc05-b");
    expect(a?.contacts[0]?.email).toBe("bounce+812-sc05-a@simulator.amazonses.com");
    expect(b?.contacts[0]?.email).toBe("bounce+812-sc05-b@simulator.amazonses.com");
    expect(a?.operationNumber).not.toBe(b?.operationNumber);
    const importerA = await h.stores.connector.parties.findImporter("imp-qa-812-sc05-a");
    const importerB = await h.stores.connector.parties.findImporter("imp-qa-812-sc05-b");
    expect(importerA?.phoneE164).not.toBe(importerB?.phoneE164);
    await h.stores.connector.parties.revokeConsent({ importerId: "imp-qa-812-sc05-a", atSim: START, by: "IMPORTER" });
    expect((await h.stores.connector.parties.getConsent("imp-qa-812-sc05-b"))?.revokedAt).toBeUndefined();
  });

  it("shares the importer of another entry when asked (SC-18), and maps the alternative contact", async () => {
    const h = worldsHarness();
    const world = await createWorld(qa("sc18", [entry("a", "op-4474", { altContacts: true }), entry("b", "op-4475", { importer: "a" })]), h.deps);
    expect(world.operations[1]?.importerId).toBe(world.operations[0]?.importerId);
    expect(world.operations[0]?.contacts.map((contact) => contact.email)).toContain("qa-812-sc18-a-konkan-ops@sim.legajo.demo.craftech.io");
    expect(world.firmMailbox).toBe("estudio-qa-812-sc18@sim.legajo.demo.craftech.io");
  });

  it("applies the QA parameters (ETA, supplier behaviour, platform row, rate limit) and builds a metrics batch world", async () => {
    const h = worldsHarness();
    const eta = "2026-10-27T10:00:00-03:00";
    const world = await createWorld({ ...qa("sc05", [entry("a", "op-4474", { etaOverride: eta, supplierOverride: { behaviour: "LATE", delayHours: 30 }, platformRow: { vessel: "Austral Boreal" } })]), rateLimitPerHour: 5 } as WorldRequest, h.deps);
    const operation = await h.stores.connector.operations.getOperation(world.operations[0]?.operationId ?? "");
    expect(Date.parse(operation.eta)).toBe(Date.parse(eta));
    expect((await h.stores.connector.timers.listTimers(operation.operationId, { status: "SCHEDULED" })).map((timer) => timer.dueAtSim)).toContain("2026-10-20T13:00:00.000Z");
    expect(await h.stores.connector.parties.findSupplier("sup-qa-812-sc05-a")).toMatchObject({ behaviour: "LATE", behaviourParams: { delayHours: 30 } });
    expect(await h.stores.client.get("Platform", { PK: `POP#firm-qa#${operation.operationNumber}`, SK: "META" })).toMatchObject({ vessel: "Austral Boreal", world: "qa", runId: "812" });
    expect((await h.stores.connector.world.getClock(world.clockId)).settings).toMatchObject({ rateLimitPerHour: 5 });

    const batch = await createWorld({ kind: "BATCH", batchId: "b1", startAtSim: START, entries: [entry("a", "op-4471")] }, h.deps);
    expect(batch).toMatchObject({ clockId: "sim-b1", firmId: "firm-sim", created: true });
    expect(await h.stores.client.get("Operations", { PK: `OP#${batch.operations[0]?.operationId ?? ""}`, SK: "META" })).not.toHaveProperty("world");
  });

  it("two guest worlds give op-4471 different addresses, each resolving only to its own world", async () => {
    const h = worldsHarness();
    const reserved = await createWorld({ kind: "GUEST", firmId: "firm-guest-01" }, h.deps);
    const visitor = await createWorld({ kind: "GUEST", firmId: "firm-guest-31", hardExpiresAtReal: "2026-10-17T13:30:00.000Z" }, h.deps);
    const first = reserved.operations.find((operation) => operation.operationNumber === "4471");
    const second = visitor.operations.find((operation) => operation.operationNumber === "4471");
    expect(first?.threadAddress).not.toBe(second?.threadAddress);
    for (const [operation, expected] of [[first, "op-4471-g01"], [second, "op-4471-g31"]] as const) {
      const parsed = parseThreadAddress(operation?.threadAddress ?? "");
      const found = await h.stores.connector.operations.findOperationByThread(parsed?.operationNumber ?? "", parsed?.threadTag ?? "");
      expect(found).toMatchObject({ status: "UNIQUE", value: { operationId: expected } });
    }
    expect((await h.stores.connector.parties.findImporter("imp-norpampa-g31"))?.phoneE164).toBe("+5491155513101");
    expect(await h.stores.connector.firms.getFirm("firm-guest-31")).toMatchObject({ kind: "GUEST", guestKind: "PUBLIC", mailboxAddress: "estudio-g31@sim.legajo.demo.craftech.io" });
    const operation = await h.stores.client.get("Operations", { PK: "OP#op-4471-g31", SK: "META" });
    expect(operation).toMatchObject({ world: "guest", expiresAt: Date.parse("2026-10-18T13:30:00.000Z") / 1000 });
  });
});

describe("[FL-086] destroyWorld", () => {
  it("leaves a tombstone, never deletes the epoch counter, and the next world of the clock continues the epoch", async () => {
    const h = worldsHarness();
    const first = await createWorld(qa("sc16", [entry("a", "op-4471")]), h.deps);
    const destroyed = await destroyWorld({ clockId: first.clockId, reason: "QA_DONE" }, h.deps);
    expect(destroyed).toMatchObject({ destroyed: true, worldEpoch: 1 });
    expect(await h.stores.connector.world.isTombstoned(first.clockId, 1)).toBe(true);
    expect(await h.stores.connector.world.findClock(first.clockId)).toBeUndefined();
    expect(await h.stores.connector.operations.findOperation(first.operations[0]?.operationId ?? "")).toBeUndefined();
    expect(await h.stores.connector.world.getLease("OPNUM", first.operations[0]?.operationNumber ?? "")).toBeUndefined();
    expect(h.purges).toHaveLength(1);
    expect(h.purges[0]).toMatchObject({ clockId: first.clockId, epoch: 1, actorIds: ["imp-qa-812-sc16-a-e1"] });

    const second = await createWorld(qa("sc16", [entry("a", "op-4471")]), h.deps);
    expect(second.worldEpoch).toBe(2);
    expect(second.operations[0]?.threadAddress).not.toBe(first.operations[0]?.threadAddress);
  });

  it("refuses a demo world (GLOBAL#firm-delta → FORBIDDEN) and the fixed QA world, and leaves them as they are", async () => {
    const h = worldsHarness();
    await createWorld({ kind: "DEMO", template: "demo-firm-delta" }, h.deps);
    expect(await rejection(destroyWorld({ clockId: "GLOBAL#firm-delta", reason: "TEST" }, h.deps))).toMatchObject({ code: "FORBIDDEN" });
    expect(await rejection(destroyWorld({ clockId: "GLOBAL#firm-qa", reason: "TEST" }, h.deps))).toMatchObject({ code: "FORBIDDEN" });
    expect(await h.stores.connector.operations.findOperation("op-4471")).toBeDefined();
  });

  it("a QA destroy deletes only items of QA worlds: a demo item reached by the same key stays", async () => {
    const h = worldsHarness();
    await createWorld({ kind: "DEMO", template: "demo-firm-delta" }, h.deps);
    const world = await createWorld(qa("sc16", [entry("a", "op-4471")]), h.deps);
    // A demo row stamped with the QA world's clock by mistake is still not of a QA world (`world` absent).
    await h.stores.client.put("Runtime", { PK: "WORLDSTATE#" + world.clockId, SK: "META", entity: "WorldState", clockId: world.clockId, inFlight: [] });
    await destroyWorld({ clockId: world.clockId, reason: "QA_DONE" }, h.deps);
    expect(await h.stores.client.get("Runtime", { PK: "WORLDSTATE#" + world.clockId, SK: "META" })).toBeDefined();
    expect(await h.stores.connector.operations.findOperation("op-4471")).toBeDefined();
  });
});

describe("[FL-087] reset through the factory", () => {
  it("rebuilds the demo world at a new epoch from its template; the broker keeps its Cognito binding", async () => {
    const h = worldsHarness();
    await createWorld({ kind: "DEMO", template: "demo-firm-delta" }, h.deps);
    const before = await h.stores.connector.operations.getOperation("op-4471");
    await h.stores.connector.firms.setBrokerCognitoSub("firm-delta", "brk-delta-diego", "sub-diego");
    const reset = await resetWorld({ clockId: "GLOBAL#firm-delta", caller: "JANITOR", actor: "SYSTEM" }, resetDepsOf(h.deps));
    expect(reset).toMatchObject({ previousEpoch: 1, worldEpoch: 2 });
    const after = await h.stores.connector.operations.getOperation("op-4471");
    expect(after.worldEpoch).toBe(2);
    expect(after.threadAddress).not.toBe(before.threadAddress);
    expect(await h.stores.client.get("Firms", brokerKey("firm-delta", "brk-delta-diego"))).toMatchObject({ cognitoSub: "sub-diego", cognitoSubKey: "SUB#sub-diego" });
    expect(h.purges.at(-1)).toMatchObject({ clockId: "GLOBAL#firm-delta", epoch: 1 });
    expect(h.purges.at(-1)?.actorIds).toContain("imp-norpampa-e1");
  });

  it("rewrites the Platform rows: the platform's ETA goes back to the template's", async () => {
    const h = worldsHarness();
    await createWorld({ kind: "DEMO", template: "demo-firm-delta" }, h.deps);
    await h.stores.client.update("Platform", { PK: "POP#firm-delta#4471", SK: "META" }, { set: { eta: "2026-10-30T08:00:00-03:00" } }, h.realNow.toISOString());
    await resetWorld({ clockId: "GLOBAL#firm-delta", caller: "QA", actor: "QA" }, resetDepsOf(h.deps));
    expect(await h.stores.client.get("Platform", { PK: "POP#firm-delta#4471", SK: "META" })).toMatchObject({ eta: "2026-10-22T08:00:00-03:00" });
  });
});
