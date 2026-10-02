// The landing's motion as numbers (FL-126, docs/landing-spec.md §4.4, §4.5 and §4.7): the hero's real
// conversation (the request, then the delegation) writes itself once in at most 12 s with the cadence
// of the spec; the final frame shows every message (reduced motion or paused animations); a counter
// eases from 0 to exactly its value in 1.2 s.
import { describe, expect, it } from "vitest";
import { heroMessages } from "../conversations";
import { CADENCE, COUNTER_MS, type ScriptLine, conversationSchedule, counterAt, easeOutCubic, finalFrame, frameAt } from "./schedule";

const SCRIPT: ScriptLine[] = heroMessages().map((message) => ({ kind: message.from === "firm" ? "firm" : message.tap ? "tap" : "text", text: message.text }));

describe("hero conversation [FL-126]", () => {
  it("plays the request and the delegation in order, firm messages typed and the importer's taps lit, in at most 12 s", () => {
    expect(SCRIPT.map((line) => line.kind)).toEqual(["firm", "tap", "firm", "tap", "firm"]);
    const schedule = conversationSchedule(SCRIPT);
    expect(schedule.totalMs).toBeLessThanOrEqual(CADENCE.maxTotalMs);
    expect(schedule.beats.map((beat) => beat.showAtMs - beat.startMs)).toEqual([CADENCE.typingMs, CADENCE.tapHighlightMs, CADENCE.typingMs, CADENCE.tapHighlightMs, CADENCE.typingMs]);
    const gaps = schedule.beats.slice(1).map((beat, index) => beat.startMs - (schedule.beats[index]?.showAtMs ?? 0));
    expect(new Set(gaps)).toEqual(new Set([CADENCE.pauseMs]));
  });

  it("shows nothing, then 'escribiendo', then each message, and every message at the end", () => {
    const schedule = conversationSchedule(SCRIPT);
    expect(frameAt(schedule, SCRIPT, 0)).toEqual({ shown: 0, done: false });
    expect(frameAt(schedule, SCRIPT, CADENCE.startDelayMs + 10)).toMatchObject({ shown: 0, pending: { index: 0, phase: "typing" } });
    const firstShown = schedule.beats[0]?.showAtMs ?? 0;
    expect(frameAt(schedule, SCRIPT, firstShown).shown).toBe(1);
    expect(frameAt(schedule, SCRIPT, schedule.totalMs)).toEqual({ shown: SCRIPT.length, done: true });
    expect(finalFrame(SCRIPT)).toEqual({ shown: SCRIPT.length, done: true });
  });

  it("writes a free text character by character, capped per message", () => {
    const lines: ScriptLine[] = [{ kind: "text", text: "x".repeat(100) }];
    const schedule = conversationSchedule(lines);
    expect((schedule.beats[0]?.showAtMs ?? 0) - (schedule.beats[0]?.startMs ?? 0)).toBe(CADENCE.maxWritingMs);
    const halfway = frameAt(schedule, lines, (schedule.beats[0]?.startMs ?? 0) + CADENCE.maxWritingMs / 2);
    expect(halfway.pending).toMatchObject({ phase: "writing", chars: 50 });
  });
});

describe("goal counters [FL-126]", () => {
  it("ease out from 0 to exactly the value in 1.2 s, and never pass it", () => {
    expect(COUNTER_MS).toBe(1_200);
    expect(counterAt(72, 0)).toBe(0);
    expect(counterAt(72, COUNTER_MS)).toBe(72);
    expect(counterAt(100, COUNTER_MS * 2)).toBe(100);
    const values = Array.from({ length: 13 }, (_, step) => counterAt(100, step * 100));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(Math.max(...values)).toBe(100);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
