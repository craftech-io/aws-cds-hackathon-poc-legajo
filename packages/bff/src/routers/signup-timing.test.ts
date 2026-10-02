// ADR-0015 §1.1: no branch shows in the time of an answer. `signup.start` and `signup.resend` do the same
// work whatever the email is and never call Cognito (that happens later, in `SignupDispatch`), so with a
// Cognito double whose calls take a different time per branch, the p50 and p95 of 200 requests per
// branch stay within 15 ms of each other, and Cognito is never called on the answer's path. Answers
// that are not CONFIRMED leave 1.5 s after the request started (checked here on the padding asked for).
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { NON_CONFIRMED_RESPONSE_MS, RESEND_WAIT_SECONDS } from "@legajo/shared/guest-limits";
import { memoryStores } from "../connector/testing";
import { type TestAccess, edgeHeaders, testAccessDeps } from "../signup/testing";
import { TEST_PASSWORD, drainDispatch, validForm } from "../signup/testing-flows";
import { type Bff, bffFor, call, trpcEvent } from "../signup/testing-http";

const SAMPLES = 200;
const TOLERANCE_MS = 15;
const BRANCHES = {
  NEW: "nueva.persona@despachos-del-sur.com.ar",
  EXISTING_GUEST: "invitada@despachos-del-sur.com.ar",
  INELIGIBLE: "despachante@despachos-del-sur.com.ar",
  SUPPRESSED: "alguien@empresa.test",
} as const;
type Branch = keyof typeof BRANCHES;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cognito answers each kind of call at its own pace: if the answer waited for it, the branch would show. */
function slowCognito(access: TestAccess): void {
  const delays: Partial<Record<keyof TestAccess["cognito"], number>> = { findByEmail: 25, groupsOf: 10, signUp: 60, forgotPassword: 40, deleteUnconfirmed: 30, resendCode: 35 };
  for (const [method, ms] of Object.entries(delays)) {
    const name = method as keyof TestAccess["cognito"];
    const original = access.cognito[name] as (...args: unknown[]) => Promise<unknown>;
    Object.assign(access.cognito, { [name]: async (...args: unknown[]) => (await sleep(ms ?? 0), original(...args)) });
  }
  access.cognito.seed({ username: "usr-guest", email: BRANCHES.EXISTING_GUEST, groups: ["GUEST"] });
  access.cognito.seed({ username: "brk-diego", email: BRANCHES.INELIGIBLE, groups: ["BROKER"], firmId: "firm-delta" });
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

interface World {
  readonly access: TestAccess;
  readonly bff: Bff;
  readonly advance: (ms: number) => void;
}

function world(): World {
  let now = new Date("2026-10-14T13:30:00.000Z");
  const stores = memoryStores();
  const access = testAccessDeps(stores, { now: () => now });
  slowCognito(access);
  return { access, bff: bffFor(stores, access), advance: (ms) => (now = new Date(now.getTime() + ms)) };
}

async function timed(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

function expectSameDistribution(samples: Readonly<Record<Branch, number[]>>): void {
  for (const p of [50, 95]) {
    const values = Object.values(samples).map((durations) => percentile(durations, p));
    expect(Math.max(...values) - Math.min(...values), `p${p} ${values.map((value) => value.toFixed(2)).join(" / ")}`).toBeLessThanOrEqual(TOLERANCE_MS);
  }
}

describe("[FL-104] signup.start and signup.resend answer alike in every branch", () => {
  it("[FL-102] p50 and p95 of 200 requests per branch within 15 ms, and no call to Cognito", async () => {
    const { access, bff, advance } = world();
    const started: Record<Branch, number[]> = { NEW: [], EXISTING_GUEST: [], INELIGIBLE: [], SUPPRESSED: [] };
    const ids: Record<Branch, string[]> = { NEW: [], EXISTING_GUEST: [], INELIGIBLE: [], SUPPRESSED: [] };
    for (let index = 0; index < SAMPLES; index += 1) {
      // A fresh day every 20 rounds keeps the per-IP and total limits out of the measure.
      if (index % 20 === 0) advance(86_400_000);
      for (const branch of Object.keys(BRANCHES) as Branch[]) {
        const event = trpcEvent("POST", "/api/signup.start", { input: validForm(access, { email: BRANCHES[branch] }), edge: edgeHeaders(`203.0.113.${index % 250}:${1_000 + index}`) });
        let answer: Awaited<ReturnType<typeof call>> | undefined;
        started[branch].push(await timed(async () => (answer = await call(bff, event))));
        expect(answer?.data).toMatchObject({ status: "CODE_SENT" });
        ids[branch].push((answer?.data as { signupId: string }).signupId);
      }
    }
    expect(access.cognito.calls).toEqual([]);
    expectSameDistribution(started);

    advance(RESEND_WAIT_SECONDS * 1000);
    const resent: Record<Branch, number[]> = { NEW: [], EXISTING_GUEST: [], INELIGIBLE: [], SUPPRESSED: [] };
    for (let index = 0; index < SAMPLES; index += 1) {
      for (const branch of Object.keys(BRANCHES) as Branch[]) {
        const event = trpcEvent("POST", "/api/signup.resend", { input: { signupId: ids[branch][index] } });
        resent[branch].push(await timed(() => call(bff, event)));
      }
    }
    expect(access.cognito.calls).toEqual([]);
    expectSameDistribution(resent);
  }, 120_000);

  it("[FL-102] every confirmation that is not CONFIRMED is padded to 1.5 s, whatever its branch", async () => {
    const { access, bff } = world();
    const asked: number[] = [];
    for (const branch of Object.keys(BRANCHES) as Branch[]) {
      const answer = await call(bff, trpcEvent("POST", "/api/signup.start", { input: validForm(access, { email: BRANCHES[branch] }) }));
      await drainDispatch(access);
      access.slept.length = 0;
      const confirmed = await call(bff, trpcEvent("POST", "/api/signup.confirm", { input: { signupId: (answer.data as { signupId: string }).signupId, code: "000000", password: TEST_PASSWORD } }));
      expect((confirmed.data as { status: string }).status).not.toBe("CONFIRMED");
      asked.push(...access.slept);
    }
    expect(asked).toEqual(Array<number>(4).fill(NON_CONFIRMED_RESPONSE_MS));
  });
});
