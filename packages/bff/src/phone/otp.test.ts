import { describe, expect, it } from "vitest";
import { digitRuns, extractOtp } from "./otp-code";
import { failedCalls, onObject, type Attempt, type OtpPorts } from "./otp";

const CONTACT = (n: number) => `0000000${n}-aaaa-bbbb-cccc-000000000000`;
const RECORDING = (n: number) => `recordings/connect/x/CallRecordings/2026/10/05/${CONTACT(n)}_20261005T12:00_UTC.wav`;
const TRANSCRIPT = (n: number) => `transcripts/${CONTACT(n)}.json`;
const transcribeOutput = (text: string) => JSON.stringify({ jobName: "otp-x", results: { transcripts: [{ transcript: text }], items: [] } });

function ports(texts: Record<string, string> = {}) {
  const store = new Map<string, unknown>();
  const mails: Array<{ subject: string; text: string }> = [];
  const jobs: string[] = [];
  const api: OtpPorts = {
    async startTranscription(input) {
      jobs.push(input.jobName);
    },
    async readText(key) {
      return texts[key] ?? "";
    },
    async putJson(key, value) {
      store.set(key, value);
    },
    async listAttempts() {
      return [...store.values()] as Attempt[];
    },
    async linkTo(key) {
      return `https://example.invalid/${key}`;
    },
    async mail(subject, text) {
      mails.push({ subject, text });
    },
    now: () => new Date("2026-10-05T12:00:00Z"),
  };
  return { api, store, mails, jobs };
}

describe("[PH-01] the six-digit code in Meta's call", () => {
  it("reads digits, grouped digits and words in English and Spanish, repeated or not", () => {
    expect(extractOtp("Your WhatsApp code is 4 8 1 5 2 9. Again, your code is 4 8 1 5 2 9.")).toBe("481529");
    expect(extractOtp("your code is 481-529")).toBe("481529");
    expect(extractOtp("Tu código de WhatsApp es cuatro ocho uno cinco dos nueve")).toBe("481529");
    expect(extractOtp("code four eight one five two nine four eight one five two nine")).toBe("481529");
    expect(extractOtp("Su código es 4 8 1 5 2 9. Repito, 4 8 1 5 2 9. 4 8 7 5 2 9")).toBe("481529");
  });

  it("finds nothing when no run is a six-digit code", () => {
    expect(extractOtp("Hello, this is WhatsApp. Goodbye.")).toBeUndefined();
    expect(extractOtp("your code is 4 8 1 5 2")).toBeUndefined();
    expect(extractOtp("12345678")).toBeUndefined();
    expect(digitRuns("call 1 2 at three")).toEqual(["12", "3"]);
  });
});

describe("[PH-02] the bot tries three calls, then hands the recording to the operator", () => {
  it("transcribes a recording and mails the code it reads, never storing it", async () => {
    const world = ports({ [TRANSCRIPT(1)]: transcribeOutput("your code is 4 8 1 5 2 9") });
    expect(await onObject(world.api, RECORDING(1))).toBe("TRANSCRIBING");
    expect(world.jobs).toEqual([`otp-${CONTACT(1)}`]);
    expect(await onObject(world.api, TRANSCRIPT(1))).toBe("READ");
    expect(world.mails.at(-1)?.subject).toContain("481529");
    expect(JSON.stringify([...world.store.values()])).not.toContain("481529");
  });

  it("asks for another call twice, hands over at the third failure and stops transcribing", async () => {
    const texts = Object.fromEntries([1, 2, 3].map((n) => [TRANSCRIPT(n), transcribeOutput("hello goodbye")]));
    const world = ports(texts);
    const outcomes = [];
    for (const n of [1, 2, 3]) {
      await onObject(world.api, RECORDING(n));
      outcomes.push(await onObject(world.api, TRANSCRIPT(n)));
    }
    expect(outcomes).toEqual(["UNREADABLE", "UNREADABLE", "HANDED_OVER"]);
    expect(world.mails.at(-1)?.text).toContain("https://example.invalid/recordings/");
    expect(await onObject(world.api, RECORDING(4))).toBe("HANDED_OVER");
    expect(world.jobs).toHaveLength(3);
    expect(failedCalls([...world.store.values()] as Attempt[], new Date("2026-10-09T12:00:00Z"))).toBe(0);
  });

  it("ignores objects that are neither a recording nor a transcript, and transcripts of unknown calls", async () => {
    const world = ports();
    expect(await onObject(world.api, "otp-attempts/x.json")).toBe("IGNORED");
    expect(await onObject(world.api, TRANSCRIPT(9))).toBe("IGNORED");
    expect(world.mails).toEqual([]);
  });
});
