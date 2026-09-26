import { beforeEach, describe, expect, it } from "vitest";
import { advance, INITIAL_STATE } from "./flow";
import { flowDeps } from "./deps";
import { changeOwnPassword } from "./password-change";
import { createSrpClient } from "./srp";
import { FAKE_POOL_ID, FakeCognito } from "./testing/fake-cognito";
import type { TokenSet } from "./tokens";

// Fixture passwords of a fake pool; they only ever reach the in-memory FakeCognito.
const PASSWORD = "Fixture-Password-1!";
const NEW_PASSWORD = "Another-Fixture-7$b";

let cognito: FakeCognito;

async function signedIn(login: string): Promise<TokenSet> {
  const transition = await advance(INITIAL_STATE, { type: "signIn", login, password: PASSWORD }, flowDeps(cognito, createSrpClient(FAKE_POOL_ID), { kind: "signIn" }));
  if (transition.state.step === "mfaSetup" && transition.state.setup.via.kind === "tokens") return transition.state.setup.via.tokens;
  if (transition.state.step !== "done") throw new Error(`not signed in: ${transition.state.step}`);
  return transition.state.tokens;
}

beforeEach(() => {
  cognito = new FakeCognito();
});

describe("a broker changes its own password", () => {
  it("changes it with the access token and signs in with the new one", async () => {
    await cognito.addUser({ email: "diego@example.test", password: PASSWORD, role: "BROKER" });
    const tokens = await signedIn("diego@example.test");
    expect(await changeOwnPassword(cognito, { tokens, isJudge: false }, { current: PASSWORD, proposed: NEW_PASSWORD })).toEqual({ ok: true });
    expect(cognito.calls.at(-1)?.operation).toBe("ChangePassword");
    await expect(signedIn("diego@example.test")).rejects.toThrow();
    expect(cognito.user("diego@example.test").password).toBe(NEW_PASSWORD);
  });

  it("reports a wrong current password as a rejected credential and a weak one before calling Cognito", async () => {
    await cognito.addUser({ email: "martina@example.test", password: PASSWORD, role: "ANALYST" });
    const tokens = await signedIn("martina@example.test");
    const calls = cognito.calls.length;
    expect(await changeOwnPassword(cognito, { tokens, isJudge: false }, { current: PASSWORD, proposed: "short" })).toEqual({ ok: false, error: "WEAK_PASSWORD" });
    expect(await changeOwnPassword(cognito, { tokens, isJudge: false }, { current: PASSWORD, proposed: PASSWORD })).toEqual({ ok: false, error: "WEAK_PASSWORD" });
    expect(cognito.calls.length).toBe(calls);
    expect(await changeOwnPassword(cognito, { tokens, isJudge: false }, { current: "Wrong-Fixture-2!", proposed: NEW_PASSWORD })).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
  });

  it("tells an outage apart", async () => {
    await cognito.addUser({ email: "c@example.test", password: PASSWORD });
    const tokens = await signedIn("c@example.test");
    cognito.failNext = { operation: "ChangePassword" };
    expect(await changeOwnPassword(cognito, { tokens, isJudge: false }, { current: PASSWORD, proposed: NEW_PASSWORD })).toEqual({ ok: false, error: "UNAVAILABLE" });
  });

  it("never changes a judge's password", async () => {
    await cognito.addUser({ username: "judge-01", password: PASSWORD, role: "JUDGE" });
    const tokens = await signedIn("judge-01");
    const calls = cognito.calls.length;
    expect(await changeOwnPassword(cognito, { tokens, isJudge: true }, { current: PASSWORD, proposed: NEW_PASSWORD })).toEqual({ ok: false, error: "UNSUPPORTED" });
    expect(cognito.calls.length).toBe(calls);
  });
});
