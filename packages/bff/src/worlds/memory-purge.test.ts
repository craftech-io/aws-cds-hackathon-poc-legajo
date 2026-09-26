import { BedrockAgentCoreClient, DeleteMemoryRecordCommand, ListEventsCommand, ListMemoryRecordsCommand, ResourceNotFoundException } from "@aws-sdk/client-bedrock-agentcore";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryStores } from "../connector/testing";
import { createWorldJanitorHandler } from "../handlers/world-janitor";
import { createLogger } from "../lib/log";
import { agentCoreMemoryAdmin } from "./memory-admin";
import { MEMORY_PURGE_INCOMPLETE_METRIC, type MemoryAdmin, MemoryPurgeEvent, type PurgeDeps, actorNamespace, purgeFirstPass, purgeRemainingPasses } from "./memory-purge";

const ACTOR = "imp-norpampa-e1";
const SESSION = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const START = "2026-09-26T15:00:00.000Z";

/** Memory in a map: events per session, records per namespace; `onPass` lets a test add late records. */
class FakeMemory implements MemoryAdmin {
  readonly events = new Map<string, string[]>();
  readonly records = new Map<string, string[]>();
  listings = 0;
  onListing: (listing: number) => void = () => undefined;

  addRecord(namespace: string, id: string): void {
    this.records.set(namespace, [...(this.records.get(namespace) ?? []), id]);
  }

  listEventIds(actorId: string, sessionId: string) {
    return Promise.resolve([...(this.events.get(`${actorId}/${sessionId}`) ?? [])]);
  }

  deleteEvent(actorId: string, sessionId: string, eventId: string) {
    const key = `${actorId}/${sessionId}`;
    this.events.set(key, (this.events.get(key) ?? []).filter((id) => id !== eventId));
    return Promise.resolve();
  }

  listRecordIds(prefix: string) {
    this.listings += 1;
    this.onListing(this.listings);
    return Promise.resolve([...this.records.entries()].filter(([namespace]) => namespace.startsWith(prefix)).flatMap(([, ids]) => ids));
  }

  deleteRecord(recordId: string) {
    for (const [namespace, ids] of this.records) this.records.set(namespace, ids.filter((id) => id !== recordId));
    return Promise.resolve();
  }
}

describe("memory purge in repeated passes", () => {
  let memory: FakeMemory;
  let lines: string[];
  let nowMs: number;
  let stores: ReturnType<typeof memoryStores>;

  const deps = (): PurgeDeps => ({
    memory,
    data: stores.connector,
    log: createLogger({ sink: (line) => void lines.push(line) }),
    now: () => new Date(nowMs),
    sleep: (ms) => {
      nowMs += ms;
      return Promise.resolve();
    },
  });

  const target = { clockId: "GLOBAL#firm-delta", epoch: 1, actorIds: [ACTOR], sessions: [{ actorId: ACTOR, sessionId: SESSION }] };

  beforeEach(() => {
    memory = new FakeMemory();
    lines = [];
    nowMs = Date.parse(START);
    stores = memoryStores();
    memory.events.set(`${ACTOR}/${SESSION}`, ["evt-1", "evt-2"]);
    memory.addRecord(`${actorNamespace(ACTOR)}preferences/`, "rec-pref-1");
    memory.addRecord(`${actorNamespace(ACTOR)}facts/`, "rec-fact-1");
  });

  it("deletes a record that appears between the first and the second pass", async () => {
    const first = await purgeFirstPass(deps(), target);
    expect(first.deleted).toBe(4);
    expect(first.target.startedAtReal).toBe(START);
    // The summary strategy finishes late: its record shows up after pass 1.
    memory.addRecord(`${actorNamespace(ACTOR)}${SESSION}/summary/`, "rec-summary-1");
    const outcome = await purgeRemainingPasses(deps(), first.target);
    expect(outcome).toEqual({ complete: true, passes: 3, deleted: 1 });
    expect([...memory.records.values()].flat()).toEqual([]);
    // 60 s to pass 2, then two listings 15 s apart.
    expect(nowMs - Date.parse(START)).toBe(90_000);
  });

  it("keeps listing until two listings in a row are empty", async () => {
    const { target: started } = await purgeFirstPass(deps(), target);
    memory.onListing = (listing) => {
      if (listing === 3) memory.addRecord(`${actorNamespace(ACTOR)}facts/`, "rec-fact-late");
    };
    const outcome = await purgeRemainingPasses(deps(), started);
    expect(outcome).toEqual({ complete: true, passes: 4, deleted: 1 });
  });

  it("audits MEMORY_PURGE_INCOMPLETE and counts the metric when the cap is reached", async () => {
    const { target: started } = await purgeFirstPass(deps(), target);
    let late = 0;
    memory.onListing = () => memory.addRecord(`${actorNamespace(ACTOR)}facts/`, `rec-late-${(late += 1)}`);
    const outcome = await purgeRemainingPasses(deps(), started);
    expect(outcome.complete).toBe(false);
    expect(nowMs - Date.parse(START)).toBeLessThanOrEqual(10 * 60_000);
    const [decision] = await stores.connector.audit.listByDecision("firm-delta", "ACTION");
    expect(decision).toMatchObject({ action: "MEMORY_PURGE_INCOMPLETE", clockId: "GLOBAL#firm-delta", detail: { epoch: 1, passes: outcome.passes } });
    expect(lines.filter((line) => line.includes(MEMORY_PURGE_INCOMPLETE_METRIC))).toHaveLength(1);
  });

  it("runs in WorldJanitor only for a well-formed MEMORY_PURGE event", async () => {
    const handler = createWorldJanitorHandler(deps());
    await expect(handler({ kind: "RESET", ...target, startedAtReal: START })).rejects.toThrow();
    await expect(handler({ kind: "MEMORY_PURGE", ...target, startedAtReal: START, extra: 1 })).rejects.toThrow();
    await expect(handler({ kind: "MEMORY_PURGE", ...target, actorIds: ["../../other"], startedAtReal: START })).rejects.toThrow();
    expect(await handler({ kind: "MEMORY_PURGE", ...target, startedAtReal: START })).toMatchObject({ complete: true, deleted: 4 });
  });

  it("accepts the documented event without startedAtReal and counts the cap from its arrival", async () => {
    const event = { kind: "MEMORY_PURGE", clockId: target.clockId, epoch: target.epoch, actorIds: target.actorIds, sessions: target.sessions };
    expect(MemoryPurgeEvent.safeParse(event).success).toBe(true);
    expect(MemoryPurgeEvent.safeParse({ ...event, sessions: undefined, sessionIds: [SESSION] }).success).toBe(false);
    const arrivedAt = nowMs;
    expect(await createWorldJanitorHandler(deps())(event)).toMatchObject({ complete: true, deleted: 4 });
    expect(nowMs - arrivedAt).toBeLessThanOrEqual(10 * 60_000);
  });
});

describe("AgentCore memory adapter", () => {
  it("pages through listings and treats a deletion of something gone as done", async () => {
    const client = new BedrockAgentCoreClient({ region: "us-east-1" });
    const mock = mockClient(client);
    mock
      .on(ListMemoryRecordsCommand, { namespace: actorNamespace(ACTOR), nextToken: undefined })
      .resolves({ memoryRecordSummaries: [{ memoryRecordId: "rec-1", content: undefined, memoryStrategyId: "s", namespaces: [], createdAt: new Date(0) }], nextToken: "page-2" })
      .on(ListMemoryRecordsCommand, { nextToken: "page-2" })
      .resolves({ memoryRecordSummaries: [{ memoryRecordId: "rec-2", content: undefined, memoryStrategyId: "s", namespaces: [], createdAt: new Date(0) }] })
      .on(ListEventsCommand)
      .resolves({ events: [] })
      .on(DeleteMemoryRecordCommand)
      .rejects(new ResourceNotFoundException({ message: "gone", $metadata: {} }));
    const admin = agentCoreMemoryAdmin({ client, memoryId: () => "mem-poc" });
    expect(await admin.listRecordIds(actorNamespace(ACTOR))).toEqual(["rec-1", "rec-2"]);
    expect(await admin.listEventIds(ACTOR, SESSION)).toEqual([]);
    await expect(admin.deleteRecord("rec-1")).resolves.toBeUndefined();
    expect(mock.commandCalls(ListMemoryRecordsCommand)[0]?.args[0].input).toMatchObject({ memoryId: "mem-poc", namespace: "/importers/imp-norpampa-e1/" });
  });
});
