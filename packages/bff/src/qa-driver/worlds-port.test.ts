// `world.create` / `world.destroy` of the QaDriver over the real world factory (FL-086): the driver's
// parsed input becomes a QA world request, the answer carries what the scenarios read, a repeated
// create answers the same world, and a destroy leaves only the tombstone (a later create gets a higher
// epoch) and hands the Memory purge on.
import { describe, expect, it } from "vitest";
import { createLogger } from "../lib/log";
import { worldsHarness } from "../worlds/testing";
import { ACTION_INPUTS } from "./contract-inputs";
import type { ActionContext } from "./ports";
import { worldFactoryPort } from "./worlds-port";

const ctx = {} as ActionContext;

const input = () =>
  ACTION_INPUTS["world.create"].parse({
    runId: "812-1",
    scenario: "sc05",
    startAtSim: "2026-10-14T10:30:00-03:00",
    operations: [{ key: "a", model: "op-4474" }],
    settings: { rateLimitPerHour: 5 },
  });

describe("the QaDriver's world factory port", () => {
  it("creates a qa-* world once, with its operations, mailbox and settings, and destroys it to a tombstone", async () => {
    const h = worldsHarness();
    const port = worldFactoryPort(() => h.deps);
    const created = await port.create(input(), ctx);
    expect(created).toMatchObject({ clockId: "qa-812-1-sc05", firmId: "firm-qa", worldEpoch: 1, created: true });
    expect(created.firmMailbox).toMatch(/^estudio-qa-812-1-sc05@sim\.legajo\.demo\.craftech\.io$/);
    expect(created.operations).toHaveLength(1);
    const [operation] = created.operations;
    expect(Object.keys(operation ?? {}).sort()).toEqual(["contacts", "importerId", "key", "operationId", "operationNumber", "supplierId", "threadAddress"]);
    expect(operation?.threadAddress).toMatch(/@legajo\.demo\.craftech\.io$/);
    expect((await h.stores.connector.world.getClock(created.clockId)).settings).toMatchObject({ rateLimitPerHour: 5 });

    expect(await port.create(input(), ctx)).toMatchObject({ clockId: created.clockId, worldEpoch: 1, created: false });

    expect(await port.destroy(created.clockId, ctx)).toEqual({ destroyed: true, worldEpoch: 1 });
    expect(h.purges.map((target) => target.clockId)).toEqual([created.clockId]);
    expect(await h.stores.connector.world.findClock(created.clockId)).toBeUndefined();
    expect(await port.destroy(created.clockId, ctx)).toEqual({ destroyed: false });
    expect(await port.create(input(), ctx)).toMatchObject({ worldEpoch: 2, created: true });
  });

  it("never destroys the fixed QA world (it is reset instead)", async () => {
    const h = worldsHarness();
    const port = worldFactoryPort(() => ({ ...h.deps, log: createLogger({ sink: () => undefined }) }));
    await expect(port.destroy("GLOBAL#firm-qa", ctx)).rejects.toMatchObject({ code: "FORBIDDEN", reason: "NOT_DESTROYABLE" });
  });
});
