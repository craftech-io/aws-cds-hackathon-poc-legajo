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
    judgeTestPassword: () => "Judge-Test-Password-1!",
    saveCredential: (username, firmId) => void saved.push([username, firmId]),
    report: () => undefined,
  };
  return { deps, calls, saved, passwords };
}

describe("console:invite", () => {
  it("plans judge, judge-test and broker invitations, and refuses anything ambiguous", () => {
    expect(planInvite(parseInviteArgs(["--stage", "poc", "--judge", "3"]))).toEqual({ kind: "JUDGE", username: "judge-03", firmId: "firm-judge-03", password: "GENERATE", resetPassword: false });
    expect(planInvite(parseInviteArgs(["--stage", "poc", "--judge-test"]))).toMatchObject({ username: "judge-test", firmId: "firm-judge-test", password: "FROM_ENV" });
    expect(planInvite(parseInviteArgs(["--stage", "poc", "--email", "Martina.Sosa@sim.legajo.demo.craftech.io", "--firm", "firm-delta", "--broker", "brk-delta-martina"]))).toEqual({
      kind: "BROKER",
      username: brokerUsername("martina.sosa@sim.legajo.demo.craftech.io"),
      email: "martina.sosa@sim.legajo.demo.craftech.io",
      firmId: "firm-delta",
      brokerId: "brk-delta-martina",
    });
    expect(brokerUsername("a@b.co")).toMatch(/^b[0-9a-f]{8}$/);
    expect(() => planInvite(parseInviteArgs(["--judge", "3"]))).toThrow(/--stage poc/);
    expect(() => planInvite(parseInviteArgs(["--stage", "poc", "--judge", "3", "--judge-test"]))).toThrow(/choose one/);
    expect(() => planInvite(parseInviteArgs(["--stage", "poc", "--judge", "100"]))).toThrow(/1 to 99/);
    expect(() => planInvite(parseInviteArgs(["--stage", "poc", "--email", "x@sim.legajo.demo.craftech.io", "--firm", "firm-judge-01", "--broker", "brk-judge-01"]))).toThrow(/judge firms/);
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

  it("creates a judge without email, with a permanent password kept for the operator, MFA off and group JUDGE", async () => {
    const { deps, calls, saved, passwords } = fakeDeps();
    await runInvite(planInvite({ stage: "poc", judge: "7" }), deps);
    expect(calls).toEqual(["create judge-07 firm-judge-07", "password judge-07", "mfa-off judge-07", "group judge-07 JUDGE"]);
    expect(saved).toEqual([["judge-07", "firm-judge-07"]]);
    expect(passwords["judge-07"]).toHaveLength(PASSWORD_LENGTH);
  });

  it("keeps an existing judge's password unless asked, and takes judge-test's from the environment", async () => {
    const kept = fakeDeps({ "judge-07": "sub-7" });
    await runInvite(planInvite({ stage: "poc", judge: "7" }), kept.deps);
    expect(kept.calls).toEqual(["mfa-off judge-07", "group judge-07 JUDGE"]);
    const test = fakeDeps();
    await runInvite(planInvite({ stage: "poc", judgeTest: true }), test.deps);
    expect(test.passwords["judge-test"]).toBe("Judge-Test-Password-1!");
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
    const path = join(mkdtempSync(join(tmpdir(), "legajo-invite-")), "judge-credentials.local.json");
    saveCredentialTo(path, "judge-01", "firm-judge-01", "x", new Date("2026-09-26T15:00:00.000Z"));
    saveCredentialTo(path, "judge-02", "firm-judge-02", "y", new Date("2026-09-26T15:00:00.000Z"));
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")) as object)).toEqual(["judge-01", "judge-02"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
