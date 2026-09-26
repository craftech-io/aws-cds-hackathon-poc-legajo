// Test kit of the runner: a `QaDriver` in memory that records every call with its key and answers from
// a table per action, and a minimal snapshot. Nothing here reaches AWS.
import type { QaActionName, QaResponse } from "@legajo/bff/qa-driver/contract";
import type { QaSnapshot } from "@legajo/bff/qa-driver/snapshot";
import type { DriverClient } from "./driver-client";

export interface RecordedCall {
  readonly action: QaActionName;
  readonly input: unknown;
  readonly key: string;
}

export type FakeAnswer = (input: unknown, key: string) => QaResponse | Promise<QaResponse>;

export function fakeDriver(answers: Partial<Record<QaActionName, FakeAnswer>> = {}): DriverClient & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async call(action, input, key) {
      calls.push({ action, input, key });
      const answer = answers[action];
      return answer === undefined ? { ok: true, replayed: false, result: {} } : answer(input, key);
    },
  };
}

export const okWith = (result: unknown): FakeAnswer => () => ({ ok: true, replayed: false, result });
export const refusedWith = (code: "UNAVAILABLE" | "FORBIDDEN" | "NOT_FOUND", reason?: string): FakeAnswer => () => ({ ok: false, error: { code, message: "refused", ...(reason === undefined ? {} : { reason }) } });

/** A snapshot with the fields the runner's helpers read; the rest empty. */
export function snapshotStub(overrides: Partial<QaSnapshot> = {}): QaSnapshot {
  return {
    operation: { operationId: "op-7001", operationNumber: "7001", firmId: "firm-qa", clockId: "qa-812-1-sc01", worldEpoch: 1, dossierStatus: "OPEN", control: "AGENT", approvedBy: null },
    clock: { mode: "PAUSED", simNow: "2026-10-15T13:00:00.000Z", worldEpoch: 1 },
    processError: null,
    inFlight: [],
    documents: [],
    versions: [],
    observations: [],
    timers: [],
    pendingTimers: [],
    messages: [],
    messageEvents: [],
    turnNotes: [],
    escalations: [],
    decisions: [],
    parties: { importer: null, consent: null, authorizations: [], supplier: null, contacts: [] },
    mailbox: [],
    usage: null,
    ...overrides,
  } as unknown as QaSnapshot;
}
