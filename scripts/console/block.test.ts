// `console:block` and `console:unblock` (ADR-0021 §16) over doubles: the in-memory `Leads` of the BFF's
// tests and a Cognito that only records. Nothing here calls AWS.
import { describe, expect, it } from "vitest";
import { memoryStores } from "../../packages/bff/src/connector/testing";
import { LEADS_TABLE } from "../../packages/bff/src/leads/lead";
import { phoneCodeKey, phoneSessionKey } from "../../packages/bff/src/phone-verification/records";
import { sessionState } from "../../packages/bff/src/phone-verification/service";
import { createPhoneStore } from "../../packages/bff/src/phone-verification/store";
import { type BlockAccount, type BlockDeps, planBlock, runBlock } from "./block";

const NOW = new Date("2026-11-27T15:00:00.000Z");
const SUB = "5a1d0c3e-0000-4000-8000-0000000000aa";

function world(users: Record<string, BlockAccount[]> = { "usr-ana": [{ username: "usr-ana", sub: SUB }], "ana@despachos-del-sur.com.ar": [{ username: "usr-ana", sub: SUB }] }) {
  const stores = memoryStores();
  const phones = createPhoneStore(stores.client);
  const calls: string[] = [];
  const lines: string[] = [];
  const deps: BlockDeps = {
    findAccounts: async (account) => users[account] ?? [],
    disableUser: async (username) => void calls.push(`disable ${username}`),
    enableUser: async (username) => void calls.push(`enable ${username}`),
    signOutEverywhere: async (username) => void calls.push(`sign-out ${username}`),
    phones: {
      setBlocked: async (sub, blocked, now) => {
        calls.push(`${blocked ? "mark" : "unmark"} ${sub}`);
        await phones.setBlocked(sub, blocked, now);
      },
      endAllSessions: (sub) => phones.endAllSessions(sub),
    },
    now: () => NOW,
    report: (line) => void lines.push(line),
  };
  return { stores, phones, calls, lines, deps };
}

describe("[FL-137] console:block", () => {
  it("parses the account and the stage, and refuses anything else", () => {
    expect(planBlock(["--stage", "poc", "--account", "usr-ana"])).toEqual({ action: "BLOCK", account: "usr-ana" });
    expect(planBlock(["--unblock", "--stage", "poc", "--account", "Ana@Despachos-del-Sur.com.ar"])).toEqual({ action: "UNBLOCK", account: "ana@despachos-del-sur.com.ar" });
    expect(() => planBlock(["--account", "usr-ana"])).toThrow(/--stage poc/);
    expect(() => planBlock(["--stage", "prod", "--account", "usr-ana"])).toThrow(/--stage poc/);
    expect(() => planBlock(["--stage", "poc"])).toThrow(/--account/);
    expect(() => planBlock(["--stage", "poc", "--account", "usr-ana", "--yes"])).toThrow(/unknown argument/);
  });

  it("marks first, then disables, signs out and deletes every phone session mark and the code in flight", async () => {
    const { stores, phones, calls, lines, deps } = world();
    await phones.markSession(SUB, "jti-1", NOW);
    await phones.markSession(SUB, "jti-2", NOW);
    await stores.client.put(LEADS_TABLE, { ...phoneCodeKey(SUB), entity: "PhoneCode", version: 1 });
    expect(await runBlock(planBlock(["--stage", "poc", "--account", "ana@despachos-del-sur.com.ar"]), deps)).toBe(1);
    expect(calls).toEqual([`mark ${SUB}`, "disable usr-ana", "sign-out usr-ana"]);
    expect(await phones.getAccount(SUB)).toMatchObject({ blockedAt: NOW.toISOString() });
    for (const key of [phoneSessionKey(SUB, "jti-1"), phoneSessionKey(SUB, "jti-2"), phoneCodeKey(SUB)]) expect(await stores.client.get(LEADS_TABLE, key)).toBeUndefined();
    expect(await sessionState({ phones, now: () => NOW }, SUB, "jti-1")).toBe("BLOCKED");
    expect(lines).toEqual(["blocked usr-ana (disabled, signed out, 3 phone session item(s) deleted)"]);
    expect(lines.join("\n")).not.toContain("@");
  });

  it("keeps the verified number, and unblocking lifts only the block", async () => {
    const { phones, calls, deps } = world();
    await phones.setVerified(SUB, "+5491155550101", "a".repeat(64), NOW);
    await runBlock({ action: "BLOCK", account: "usr-ana" }, deps);
    expect(await phones.getAccount(SUB)).toMatchObject({ phone: "+5491155550101", blockedAt: NOW.toISOString() });
    calls.length = 0;
    await runBlock(planBlock(["--unblock", "--stage", "poc", "--account", "usr-ana"]), deps);
    expect(calls).toEqual(["enable usr-ana", `unmark ${SUB}`]);
    const account = await phones.getAccount(SUB);
    expect(account).toMatchObject({ phone: "+5491155550101" });
    expect(account?.blockedAt).toBeUndefined();
    expect(await sessionState({ phones, now: () => NOW }, SUB, "jti-1")).toBe("REQUIRED");
  });

  it("blocks every user of an address, and changes nothing for an account that does not exist", async () => {
    const two = world({ "ana@despachos-del-sur.com.ar": [{ username: "usr-ana", sub: SUB }, { username: "b0000cccc", sub: "sub-staff" }] });
    expect(await runBlock({ action: "BLOCK", account: "ana@despachos-del-sur.com.ar" }, two.deps)).toBe(2);
    expect(two.calls.filter((call) => call.startsWith("disable"))).toEqual(["disable usr-ana", "disable b0000cccc"]);
    const none = world({});
    await expect(runBlock({ action: "BLOCK", account: "usr-nadie" }, none.deps)).rejects.toThrow(/nothing was changed/);
    expect(none.calls).toEqual([]);
  });
});
