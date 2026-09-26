import { describe, expect, it } from "vitest";
import { sha256Hex } from "../lib/crypto";
import { WaitForExtraction } from "./contract-inputs";
import { matchesKeywords } from "./keywords";
import { type MemoryReader, type StoredRecord, inspectMemory, waitForExtraction } from "./memory-inspect";

const ACTOR = "imp-qa-812-1-sc09-a-e1";
const SESSION = "0123456789abcdef0123456789abcdef0123456789abcdef";
const TARGET = { actorId: ACTOR, sessionIds: [SESSION] };
const NS = {
  preferences: `/importers/${ACTOR}/preferences/`,
  facts: `/importers/${ACTOR}/facts/`,
  summary: `/importers/${ACTOR}/${SESSION}/summary/`,
};
const START = Date.parse("2026-09-26T15:00:00.000Z");
const A = ["emoji", "emojis", "emoticon", "emoticons", "emoticones"];

type Timeline = Array<{ readonly fromSec: number; readonly namespace: string; readonly record: StoredRecord }>;

/** A reader whose namespaces fill up as the fake time passes. */
function scripted(timeline: Timeline, clock: () => number): MemoryReader {
  return {
    listEvents: () => Promise.resolve([{ eventId: "ev-1", text: "Te paso el CUIT [CUIT]" }]),
    listRecords: (namespace) => {
      const elapsed = (clock() - START) / 1_000;
      const latest = new Map<string, StoredRecord>();
      for (const entry of timeline) if (entry.namespace === namespace && entry.fromSec <= elapsed) latest.set(entry.record.memoryRecordId, entry.record);
      return Promise.resolve([...latest.values()]);
    },
  };
}

function time() {
  let at = START;
  return { now: () => new Date(at), sleep: (ms: number) => Promise.resolve(void (at += ms)), clock: () => at, elapsedSec: () => (at - START) / 1_000 };
}

const record = (id: string, text: string, createdAt = "2026-09-26T15:01:00.000Z"): StoredRecord => ({ memoryRecordId: id, createdAt, text });
const wait = (overrides: Partial<WaitForExtraction> = {}) =>
  WaitForExtraction.parse({ sentinel: { keywords: A }, baseline: [], afterTs: new Date(START).toISOString(), ...overrides });

describe("memory.inspect: sentinel keywords", () => {
  it("matches whole words without case or accents, also when the extractor translates", () => {
    expect(matchesKeywords("Prefiere mensajes sin EMOTICONES", A)).toBe(true);
    expect(matchesKeywords("The importer prefers messages without emojis.", A)).toBe(true);
    expect(matchesKeywords("Emoticón al final", ["emoticon"])).toBe(true);
    expect(matchesKeywords("emojify the text", A)).toBe(false);
  });
});

describe("memory.inspect: waitForExtraction completes strategy by strategy", () => {
  it("waits for the sentinel preference, new facts and a new summary, then 60 s of stability", async () => {
    const t = time();
    const reader = scripted(
      [
        { fromSec: 45, namespace: NS.preferences, record: record("p1", "Prefers messages without emojis") },
        { fromSec: 90, namespace: NS.facts, record: record("f1", "Usually uploads documents through the link") },
        { fromSec: 150, namespace: NS.summary, record: record("s1", "Importer asked about the certificate") },
      ],
      t.clock,
    );
    const done = await waitForExtraction({ reader, now: t.now, sleep: t.sleep }, TARGET, wait());
    expect(done.completion).toEqual({ preferences: "MATCHED", facts: "NEW_OR_CHANGED", summary: "NEW_OR_CHANGED" });
    expect(t.elapsedSec()).toBeGreaterThanOrEqual(150 + 60);
    expect(done.records.map((item) => item.strategy).sort()).toEqual(["facts", "preferences", "summary"]);
    expect(done.records.find((item) => item.memoryRecordId === "p1")?.contentSha256).toBe(sha256Hex("Prefers messages without emojis"));
    expect(done.events).toHaveLength(1);
  });

  it("accepts a consolidating strategy that did nothing: QUIET after 60 s stable and 180 s since the turn", async () => {
    const t = time();
    const reader = scripted([{ fromSec: 30, namespace: NS.preferences, record: record("p1", "Tone: no emoji, please") }], t.clock);
    const done = await waitForExtraction({ reader, now: t.now, sleep: t.sleep }, TARGET, wait());
    expect(done.completion).toEqual({ preferences: "MATCHED", facts: "QUIET", summary: "QUIET" });
    expect(t.elapsedSec()).toBeGreaterThanOrEqual(180);
  });

  it("does not take a record of the baseline, but takes the same record rewritten by a consolidation", async () => {
    const old = record("p1", "Prefers messages without emojis");
    const baseline = [{ memoryRecordId: "p1", createdAt: old.createdAt, contentSha256: sha256Hex(old.text) }];
    const t = time();
    const reader = scripted(
      [
        { fromSec: 0, namespace: NS.preferences, record: old },
        { fromSec: 120, namespace: NS.preferences, record: record("p1", "Prefers messages without emojis or stickers") },
      ],
      t.clock,
    );
    const done = await waitForExtraction({ reader, now: t.now, sleep: t.sleep }, TARGET, wait({ baseline }));
    expect(done.completion?.preferences).toBe("MATCHED");
    expect(t.elapsedSec()).toBeGreaterThanOrEqual(120);
  });

  it("fails naming the preference when the sentinel never shows up", async () => {
    const t = time();
    const reader = scripted([{ fromSec: 30, namespace: NS.facts, record: record("f1", "Usually uploads through the link") }], t.clock);
    await expect(waitForExtraction({ reader, now: t.now, sleep: t.sleep }, TARGET, wait({ timeoutSec: 300 }))).rejects.toMatchObject({
      reason: "EXTRACTION_INCOMPLETE",
      message: expect.stringContaining("preferences"),
    });
  });

  it("fails naming the strategy still open when the turn ended too recently to call it quiet", async () => {
    const t = time();
    const reader = scripted([{ fromSec: 15, namespace: NS.preferences, record: record("p1", "no emoji") }], t.clock);
    const afterTs = new Date(START + 200_000).toISOString();
    await expect(waitForExtraction({ reader, now: t.now, sleep: t.sleep }, TARGET, wait({ afterTs, timeoutSec: 120 }))).rejects.toMatchObject({ message: expect.stringContaining("facts and summary") });
  });

  it("lists an actor's records and its sessions' events without waiting", async () => {
    const t = time();
    const reader = scripted([{ fromSec: 0, namespace: NS.facts, record: record("f1", "Suele subir por el link") }], t.clock);
    const inspection = await inspectMemory(reader, TARGET);
    expect(inspection.records).toHaveLength(1);
    expect(inspection.events[0]).toMatchObject({ sessionId: SESSION, eventId: "ev-1" });
  });
});
