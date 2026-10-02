import { beforeEach, describe, expect, it } from "vitest";
import { flowDeps, subOf } from "./deps";
import { type AuthFlowAction, type AuthFlowDeps, type AuthFlowState, type FlowMode, INITIAL_STATE, type Transition, advance } from "./flow";
import { createSrpClient } from "./srp";
import { FAKE_POOL_ID, FakeCognito } from "./testing/fake-cognito";
import { randomBase32Secret, totpCode } from "./testing/totp";

// Fixture passwords of a fake pool; they only ever reach the in-memory FakeCognito.
const PASSWORD = "Fixture-Password-1!";
const TEMPORARY = "Temp-Fixture-9#Aa";
const NEW_PASSWORD = "Another-Fixture-7$b";

let cognito: FakeCognito;

function deps(mode: FlowMode = { kind: "signIn" }): AuthFlowDeps {
  return flowDeps(cognito, createSrpClient(FAKE_POOL_ID), mode);
}

async function run(state: AuthFlowState, action: AuthFlowAction, mode?: FlowMode): Promise<Transition> {
  return advance(state, action, deps(mode));
}

function expectStep<S extends AuthFlowState["step"]>(transition: Transition, step: S): Extract<AuthFlowState, { step: S }> {
  expect(transition.error).toBeUndefined();
  expect(transition.state.step).toBe(step);
  return transition.state as Extract<AuthFlowState, { step: S }>;
}

beforeEach(() => {
  cognito = new FakeCognito();
});

describe("sign in with email and password (USER_SRP_AUTH)", () => {
  it("proves the password by SRP: the password itself never crosses the wire", async () => {
    await cognito.addUser({ email: "analyst@example.test", password: PASSWORD, role: "ANALYST", totpSecret: randomBase32Secret() });
    const challenge = expectStep(await run(INITIAL_STATE, { type: "signIn", login: " Analyst@Example.test ", password: PASSWORD }), "totp");
    expect(challenge.challenge.login).toBe("analyst@example.test");
    expect(cognito.calls.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    for (const call of cognito.calls) expect(call.payload).not.toContain(PASSWORD);
  });

  it("answers a wrong password and an unknown email with the same error", async () => {
    await cognito.addUser({ email: "someone@example.test", password: PASSWORD });
    const wrongPassword = await run(INITIAL_STATE, { type: "signIn", login: "someone@example.test", password: "Wrong-Fixture-1!" });
    const unknownEmail = await run(INITIAL_STATE, { type: "signIn", login: "nobody@example.test", password: PASSWORD });
    expect(wrongPassword).toEqual({ state: INITIAL_STATE, error: "INVALID_CREDENTIALS" });
    expect(unknownEmail).toEqual(wrongPassword);
  });

  it("reports an account that must reset its password as a plain rejection", async () => {
    await cognito.addUser({ email: "reset@example.test", password: PASSWORD });
    cognito.failNext = { operation: "InitiateAuth", type: "PasswordResetRequiredException" };
    expect((await run(INITIAL_STATE, { type: "signIn", login: "reset@example.test", password: PASSWORD })).error).toBe("INVALID_CREDENTIALS");
  });

  it("tells throttling and outages apart from a rejection", async () => {
    cognito.failNext = { operation: "InitiateAuth", type: "TooManyRequestsException" };
    expect((await run(INITIAL_STATE, { type: "signIn", login: "a@example.test", password: PASSWORD })).error).toBe("TOO_MANY_ATTEMPTS");
    cognito.failNext = { operation: "InitiateAuth" };
    expect((await run(INITIAL_STATE, { type: "signIn", login: "a@example.test", password: PASSWORD })).error).toBe("UNAVAILABLE");
  });
});

describe("first login after an invitation (NEW_PASSWORD_REQUIRED → optional TOTP)", () => {
  it("offers a BROKER TOTP after the temporary password and enrols when asked", async () => {
    await cognito.addUser({ email: "despachante@example.test", password: TEMPORARY, role: "BROKER", status: "FORCE_CHANGE_PASSWORD" });
    const newPassword = expectStep(await run(INITIAL_STATE, { type: "signIn", login: "despachante@example.test", password: TEMPORARY }), "newPassword");

    const weak = await run(newPassword, { type: "newPassword", password: "short" });
    expect(weak).toEqual({ state: newPassword, error: "WEAK_PASSWORD" });

    const setup = expectStep(await run(newPassword, { type: "newPassword", password: NEW_PASSWORD }), "mfaSetup");
    expect(setup.setup.optional).toBe(true);
    expect(setup.setup.secret).toMatch(/^[A-Z2-7]{32}$/);

    expect(await run(setup, { type: "verifyMfaSetup", code: "000000" })).toEqual({ state: setup, error: "INVALID_CODE" });
    const done = expectStep(await run(setup, { type: "verifyMfaSetup", code: await totpCode(setup.setup.secret) }), "done");
    expect(done.totpVerified).toBe(true);
    expect(cognito.user("despachante@example.test").totpEnabled).toBe(true);

    // From now on the code is asked on every sign-in.
    const again = expectStep(await run(INITIAL_STATE, { type: "signIn", login: "despachante@example.test", password: NEW_PASSWORD }), "totp");
    expectStep(await run(again, { type: "totp", code: await cognito.currentCode("despachante@example.test") }), "done");
  });

  it("lets an ANALYST skip TOTP", async () => {
    await cognito.addUser({ email: "analista@example.test", password: TEMPORARY, role: "ANALYST", status: "FORCE_CHANGE_PASSWORD" });
    const newPassword = expectStep(await run(INITIAL_STATE, { type: "signIn", login: "analista@example.test", password: TEMPORARY }), "newPassword");
    const setup = expectStep(await run(newPassword, { type: "newPassword", password: NEW_PASSWORD }), "mfaSetup");
    expect(setup.setup.optional).toBe(true);
    const done = expectStep(await run(setup, { type: "skipMfaSetup" }), "done");
    expect(done.totpVerified).toBe(false);
    expect(cognito.user("analista@example.test").totpEnabled).toBe(false);
  });

  it("signs a GUEST in with its username (no email) and never offers TOTP", async () => {
    await cognito.addUser({ username: "guest-01", password: PASSWORD, role: "GUEST" });
    const done = expectStep(await run(INITIAL_STATE, { type: "signIn", login: " Guest-01 ", password: PASSWORD }), "done");
    expect(done.totpVerified).toBe(false);
    expect(JSON.parse(cognito.calls[0]?.payload ?? "{}")).toMatchObject({ username: "guest-01" });
    expect(cognito.calls.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
  });

  it("keeps the step when Cognito rejects the new password", async () => {
    await cognito.addUser({ email: "c@example.test", password: TEMPORARY, status: "FORCE_CHANGE_PASSWORD" });
    const newPassword = expectStep(await run(INITIAL_STATE, { type: "signIn", login: "c@example.test", password: TEMPORARY }), "newPassword");
    cognito.failNext = { operation: "RespondToAuthChallenge", type: "InvalidPasswordException" };
    expect(await run(newPassword, { type: "newPassword", password: NEW_PASSWORD })).toEqual({ state: newPassword, error: "WEAK_PASSWORD" });
  });

  it("starts over when the challenge session expired", async () => {
    await cognito.addUser({ email: "slow@example.test", password: TEMPORARY, status: "FORCE_CHANGE_PASSWORD" });
    const newPassword = expectStep(await run(INITIAL_STATE, { type: "signIn", login: "slow@example.test", password: TEMPORARY }), "newPassword");
    cognito.expireSessions();
    expect(await run(newPassword, { type: "newPassword", password: NEW_PASSWORD })).toEqual({ state: INITIAL_STATE, error: "SESSION_EXPIRED" });
  });
});

describe("the TOTP code (SOFTWARE_TOKEN_MFA)", () => {
  it("rejects a wrong or malformed code and accepts the current one", async () => {
    await cognito.addUser({ email: "broker@example.test", password: PASSWORD, role: "BROKER", totpSecret: randomBase32Secret() });
    const totp = expectStep(await run(INITIAL_STATE, { type: "signIn", login: "broker@example.test", password: PASSWORD }), "totp");
    expect(await run(totp, { type: "totp", code: "12ab" })).toEqual({ state: totp, error: "INVALID_CODE" });
    expect(await run(totp, { type: "totp", code: "000000" })).toEqual({ state: totp, error: "INVALID_CODE" });
    const code = await cognito.currentCode("broker@example.test");
    const done = expectStep(await run(totp, { type: "totp", code: `${code.slice(0, 3)} ${code.slice(3)}` }), "done");
    expect(done.totpVerified).toBe(true);
    expect(done.tokens.refreshToken).toBeDefined();
  });
});

describe("MFA_SETUP (a pool where Cognito itself requires MFA)", () => {
  it("associates, verifies and finishes the challenge through the session", async () => {
    cognito.mfa = "ON";
    await cognito.addUser({ email: "on@example.test", password: PASSWORD, role: "ANALYST" });
    const setup = expectStep(await run(INITIAL_STATE, { type: "signIn", login: "on@example.test", password: PASSWORD }), "mfaSetup");
    expect(setup.setup.optional).toBe(false);
    expect(setup.setup.via.kind).toBe("challenge");
    const done = expectStep(await run(setup, { type: "verifyMfaSetup", code: await totpCode(setup.setup.secret) }), "done");
    expect(done.totpVerified).toBe(true);
    expect(cognito.calls.map((call) => call.operation)).toContain("SetUserMFAPreference");
  });
});

describe("forgot password (ForgotPassword → ConfirmForgotPassword)", () => {
  it("answers a known and an unknown email with the same next screen", async () => {
    await cognito.addUser({ email: "known@example.test", password: PASSWORD });
    const request = expectStep(await run(INITIAL_STATE, { type: "forgot" }), "forgotRequest");
    const known = await run(request, { type: "requestReset", email: "known@example.test" });
    const unknown = await run(request, { type: "requestReset", email: "unknown@example.test" });
    expect(known.state.step).toBe("forgotConfirm");
    expect(unknown.state.step).toBe("forgotConfirm");
    expect(known.error).toBeUndefined();
    expect(unknown.error).toBeUndefined();
  });

  it("treats an invited account still on its temporary password the same way", async () => {
    await cognito.addUser({ email: "invited@example.test", password: TEMPORARY, status: "FORCE_CHANGE_PASSWORD" });
    expectStep(await run({ step: "forgotRequest" }, { type: "requestReset", email: "invited@example.test" }), "forgotConfirm");
  });

  it("resets with the emailed code and signs in with the new password", async () => {
    await cognito.addUser({ email: "olvido@example.test", password: PASSWORD, role: "ANALYST" });
    const confirm = expectStep(await run({ step: "forgotRequest" }, { type: "requestReset", email: "olvido@example.test" }), "forgotConfirm");
    const code = cognito.sentResetCode("olvido@example.test") ?? "";
    expect(await run(confirm, { type: "confirmReset", code: "123", password: NEW_PASSWORD })).toEqual({ state: confirm, error: "INVALID_CODE" });
    expect(await run(confirm, { type: "confirmReset", code, password: "weak" })).toEqual({ state: confirm, error: "WEAK_PASSWORD" });
    const wrong = code === "111111" ? "222222" : "111111";
    expect(await run(confirm, { type: "confirmReset", code: wrong, password: NEW_PASSWORD })).toEqual({ state: confirm, error: "INVALID_CODE" });
    expect(await run(confirm, { type: "confirmReset", code, password: NEW_PASSWORD })).toEqual({ state: { step: "credentials", notice: "passwordReset" } });
    expect((await run(INITIAL_STATE, { type: "signIn", login: "olvido@example.test", password: PASSWORD })).error).toBe("INVALID_CREDENTIALS");
    expectStep(await run(INITIAL_STATE, { type: "signIn", login: "olvido@example.test", password: NEW_PASSWORD }), "mfaSetup");
  });

  it("is not offered inside a step-up", async () => {
    const user = await cognito.addUser({ email: "x@example.test", password: PASSWORD });
    expect((await run(INITIAL_STATE, { type: "forgot" }, { kind: "stepUp", sub: user.sub, login: user.email })).state).toBe(INITIAL_STATE);
  });
});

describe("recent-login step-up (a fresh auth_time to approve or reopen)", () => {
  it("signs the same person in again with the code, whatever email the form carries", async () => {
    const user = await cognito.addUser({ email: "ana@example.test", password: PASSWORD, totpSecret: randomBase32Secret() });
    const mode: FlowMode = { kind: "stepUp", sub: user.sub, login: user.email };
    const totp = expectStep(await run(INITIAL_STATE, { type: "signIn", login: "intruder@example.test", password: PASSWORD }, mode), "totp");
    expect(totp.challenge.login).toBe("ana@example.test");
    const done = expectStep(await run(totp, { type: "totp", code: await cognito.currentCode(user.email) }, mode), "done");
    expect(done.totpVerified).toBe(true);
    expect(subOf(done.tokens)).toBe(user.sub);
  });

  it("refuses, and revokes, a sign-in of somebody else", async () => {
    await cognito.addUser({ email: "other@example.test", password: PASSWORD, role: "ANALYST" });
    const mode: FlowMode = { kind: "stepUp", sub: "not-the-same-sub", login: "other@example.test" };
    const result = await run(INITIAL_STATE, { type: "signIn", login: "other@example.test", password: PASSWORD }, mode);
    expect(result).toEqual({ state: INITIAL_STATE, error: "DIFFERENT_USER" });
    expect(cognito.revoked.size).toBe(1);
  });

  it("signs a user without TOTP in again with the password alone, without offering an enrolment", async () => {
    const user = await cognito.addUser({ email: "sin-totp@example.test", password: PASSWORD, role: "BROKER" });
    const mode: FlowMode = { kind: "stepUp", sub: user.sub, login: user.email };
    const done = expectStep(await run(INITIAL_STATE, { type: "signIn", login: user.email, password: PASSWORD }, mode), "done");
    expect(done.totpVerified).toBe(false);
    expect(subOf(done.tokens)).toBe(user.sub);
  });
});

describe("recent-login step-up of a guest", () => {
  it("signs the guest in again by its username, with the password alone", async () => {
    const user = await cognito.addUser({ username: "guest-01", password: PASSWORD, role: "GUEST" });
    const mode: FlowMode = { kind: "stepUp", sub: user.sub, login: "guest-01" };
    const done = expectStep(await run(INITIAL_STATE, { type: "signIn", login: "", password: PASSWORD }, mode), "done");
    expect(subOf(done.tokens)).toBe(user.sub);
    expect(cognito.calls.map((call) => call.operation)).not.toContain("GetUser");
  });
});

describe("restart", () => {
  it("goes back to the credentials from any step", async () => {
    expect(await run({ step: "forgotConfirm", email: "a@example.test" }, { type: "restart" })).toEqual({ state: INITIAL_STATE });
  });
});
