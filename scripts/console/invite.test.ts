import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleRole } from "@legajo/shared";
import { describe, expect, it } from "vitest";
import { type InviteDeps, PASSWORD_LENGTH, brokerUsername, generatePassword, parseInviteArgs, planInvite, runInvite, saveCredentialTo } from "./invite";

function fakeDeps(existing: Record<string, string> = {}, roles: Record<string, ConsoleRole> = {}) {
  const calls: string[] = [];
  const saved: Array<[string, string]> = [];
  const passwords: Record<string, string> = {};
  const deps: InviteDeps = {
    findUser: async (username) => (existing[username] ? { sub: existing[username] } : undefined),
    createUser: async ({ username, firmId, email }) => {
      calls.push(`create ${username} ${firmId}${email ? ` ${email}` : ""}`);
      return { sub: `sub-${username}` };
    },
    setPermanentPassword: async (username, password) => {
      passwords[username] = password;
      calls.push(`password ${username}`);
    },
    disableMfa: async (username) => void calls.push(`mfa-off ${username}`),
    addToGroup: async (username, group) => void calls.push(`group ${username} ${group}`),
    brokerRole: async (firmId, brokerId) => roles[`${firmId}/${brokerId}`] ?? "BROKER",
    bindBroker: async (firmId, brokerId, sub) => void calls.push(`bind ${firmId}/${brokerId} ${sub}`),
    guestTestPassword: () => "Guest-Test-Password-1!",
    saveCredential: (username, firmId) => void saved.push([username, firmId]),
    report: () => undefined,
  };
  return { deps, calls, saved, passwords };
}

describe("console:invite", () => {
  it("plans guest, guest-test and broker invitations, and refuses anything ambiguous", () => {
    expect(planInvite(parseInviteArgs(["--stage", "poc", "--guest", "3"]))).toEqual({ kind: "GUEST", username: "guest-03", firmId: "firm-guest-03", password: "GENERATE", resetPassword: false });
    expect(planInvite(parseInviteArgs(["--stage", "poc", "--guest-test"]))).toMatchObject({ username: "guest-test", firmId: "firm-guest-test", password: "FROM_ENV" });
    expect(planInvite(parseInviteArgs(["--stage", "poc", "--email", "Martina.Sosa@sim.legajo.demo.craftech.io", "--firm", "firm-delta", "--broker", "brk-delta-martina"]))).toEqual({
      kind: "BROKER",
      username: brokerUsername("martina.sosa@sim.legajo.demo.craftech.io"),
      email: "martina.sosa@sim.legajo.demo.craftech.io",
      firmId: "firm-delta",
      brokerId: "brk-delta-martina",
    });
    expect(brokerUsername("a@b.co")).toMatch(/^b[0-9a-f]{8}$/);
    expect(() => planInvite(parseInviteArgs(["--guest", "3"]))).toThrow(/--stage poc/);
    expect(() => planInvite(parseInviteArgs(["--stage", "poc", "--guest", "3", "--guest-test"]))).toThrow(/choose one/);
    expect(() => planInvite(parseInviteArgs(["--stage", "poc", "--guest", "100"]))).toThrow(/1 to 99/);
    expect(() => planInvite(parseInviteArgs(["--stage", "poc", "--email", "x@sim.legajo.demo.craftech.io", "--firm", "firm-guest-01", "--broker", "brk-guest-01"]))).toThrow(/guest firms/);
    expect(() => parseInviteArgs(["--stage", "poc", "--jugde", "3"])).toThrow(/unknown argument/);
  });

  it("generates passwords with every class the pool requires", () => {
    for (let round = 0; round < 50; round += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(PASSWORD_LENGTH);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!#%+\-=?@^_]/);
    }
  });

  it("creates a guest without email, with a permanent password kept for the operator, MFA off and group GUEST", async () => {
    const { deps, calls, saved, passwords } = fakeDeps();
    await runInvite(planInvite({ stage: "poc", guest: "7" }), deps);
    expect(calls).toEqual(["create guest-07 firm-guest-07", "password guest-07", "mfa-off guest-07", "group guest-07 GUEST"]);
    expect(saved).toEqual([["guest-07", "firm-guest-07"]]);
    expect(passwords["guest-07"]).toHaveLength(PASSWORD_LENGTH);
  });

  it("keeps an existing guest's password unless asked, and takes guest-test's from the environment", async () => {
    const kept = fakeDeps({ "guest-07": "sub-7" });
    await runInvite(planInvite({ stage: "poc", guest: "7" }), kept.deps);
    expect(kept.calls).toEqual(["mfa-off guest-07", "group guest-07 GUEST"]);
    const test = fakeDeps();
    await runInvite(planInvite({ stage: "poc", guestTest: true }), test.deps);
    expect(test.passwords["guest-test"]).toBe("Guest-Test-Password-1!");
    expect(test.saved).toEqual([]);
  });

  it("invites a broker by email with the role of its row and binds the row to the new sub", async () => {
    const { deps, calls } = fakeDeps({}, { "firm-delta/brk-delta-martina": "ANALYST" });
    const plan = planInvite({ stage: "poc", email: "martina.sosa@sim.legajo.demo.craftech.io", firm: "firm-delta", broker: "brk-delta-martina" });
    await runInvite(plan, deps);
    const username = brokerUsername("martina.sosa@sim.legajo.demo.craftech.io");
    expect(calls).toEqual([`create ${username} firm-delta martina.sosa@sim.legajo.demo.craftech.io`, `group ${username} ANALYST`, `bind firm-delta/brk-delta-martina sub-${username}`]);
  });

  it("writes the credentials file readable by its owner only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "legajo-invite-")), "guest-credentials.local.json");
    saveCredentialTo(path, "guest-01", "firm-guest-01", "x", new Date("2026-09-26T15:00:00.000Z"));
    saveCredentialTo(path, "guest-02", "firm-guest-02", "y", new Date("2026-09-26T15:00:00.000Z"));
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")) as object)).toEqual(["guest-01", "guest-02"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
