// The deletion of a lead and its account (ADR-0015 §6, FL-118): one module for `leads:delete`, the
// retention of the sweep and SC-26's `lead.purge`. The world's destruction is `WorldJanitor`'s
// `GUEST_DESTROY` (janitor/guest-destroy.ts; the sweep's retention runs it in process, tested there);
// here, that it is asked for, and that everything else keyed by the email is gone, leaving only a
// tombstone without personal data.
import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { leadEmailHash, mailboxQuotaHash } from "../lib/crypto";
import { markMailStatus, readMailStatus } from "../channels/email/mail-status";
import { createLogger } from "../lib/log";
import { RUNTIME_TABLE } from "../signup/counters";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { startSignup } from "../signup/testing-flows";
import { signupConfirm } from "../signup/service";
import { accountWorldKey, leaseAccountWorld, markAccountWorld } from "../worlds/guest-slots";
import { deleteLead } from "./delete";
import { LEADS_TABLE, tombKey } from "./lead";

const EMAIL = "ana.gomez@despachos-del-sur.com.ar";
const NOW = new Date("2026-10-14T13:30:00.000Z");
const log = createLogger({ level: "error" });
let stores: MemoryStores;
let access: TestAccess;

beforeEach(async () => {
  stores = memoryStores();
  access = testAccessDeps(stores, { now: () => NOW });
  const { signupId } = await startSignup(access, { email: EMAIL });
  const username = (await access.signups.get(signupId, NOW))?.accountUsername ?? "";
  await signupConfirm(access, { signupId, code: access.cognito.lastCode(username) ?? "", password: "Quince-Caballos-7" }, { ipHash: "ip-a", log });
  await markMailStatus({ client: stores.client, leadEmailKey: access.keys.leadEmail, log, now: () => NOW }, { kind: "BOUNCE", recipients: [EMAIL] });
});

const deps = () => ({ ...access, leadEmailKey: access.keys.leadEmail });
const hash = () => leadEmailHash(access.keys.leadEmail, EMAIL);

describe("[FL-118] deleting a lead on request", () => {
  it("deletes the account, the lead, the bounce state and the counters, and leaves a tombstone without personal data", async () => {
    const leadId = (await access.leads.get(hash()))?.leadId;
    expect(stores.client.dump(RUNTIME_TABLE).some((row) => row.PK.startsWith(`RL#START#EMAIL#${mailboxQuotaHash(access.keys.leadEmail, EMAIL)}`))).toBe(true);
    const deletion = await deleteLead(deps(), EMAIL, "REQUEST");
    expect(deletion).toEqual({ leadId, users: 1, worldsDestroyed: 0 });
    expect([...access.cognito.users.values()].filter((user) => user.email === EMAIL)).toEqual([]);
    expect(await access.leads.get(hash())).toBeUndefined();
    expect(await readMailStatus(stores.client, hash())).toBeUndefined();
    expect(stores.client.dump(RUNTIME_TABLE).filter((row) => row.PK.includes(hash()))).toEqual([]);
    // The per-mailbox quotas (`RL#START#EMAIL#`, `RL#MAIL#RCPT#`) are keyed by the canonical mailbox.
    expect(stores.client.dump(RUNTIME_TABLE).filter((row) => row.PK.includes(mailboxQuotaHash(access.keys.leadEmail, EMAIL)))).toEqual([]);
    const tomb = await stores.client.get(LEADS_TABLE, tombKey(leadId ?? ""));
    expect(tomb).toMatchObject({ leadId, reason: "REQUEST", deletedAt: NOW.toISOString() });
    expect(JSON.stringify(tomb)).not.toContain("despachos-del-sur");
    expect(JSON.stringify(stores.client.dump(LEADS_TABLE))).not.toContain(EMAIL);
  });

  it("asks WorldJanitor to destroy a leased world (GUEST_DESTROY) and deletes the account's lease", async () => {
    const user = [...access.cognito.users.values()].find((entry) => entry.email === EMAIL);
    await leaseAccountWorld(stores.client, user?.sub ?? "", "lease-1", NOW);
    await markAccountWorld(stores.client, user?.sub ?? "", "lease-1", { state: "READY", nn: 41, firmId: "firm-guest-41" }, NOW);
    expect((await deleteLead(deps(), EMAIL, "REQUEST")).worldsDestroyed).toBe(1);
    expect(access.invoker.invoked.filter((call) => call.target === "WorldJanitor").map((call) => call.payload)).toEqual([{ kind: "GUEST_DESTROY", firmId: "firm-guest-41", reason: "REQUEST", sub: user?.sub }]);
    expect(await stores.client.get(RUNTIME_TABLE, accountWorldKey(user?.sub ?? ""))).toBeUndefined();
  });

  it("a lease that failed (no world) is deleted with the account; a second run finds nothing", async () => {
    const user = [...access.cognito.users.values()].find((entry) => entry.email === EMAIL);
    await leaseAccountWorld(stores.client, user?.sub ?? "", "lease-1", NOW);
    await markAccountWorld(stores.client, user?.sub ?? "", "lease-1", { state: "FAILED", reason: "CAPACITY" }, NOW);
    await deleteLead(deps(), EMAIL, "REQUEST");
    expect(await stores.client.get(RUNTIME_TABLE, accountWorldKey(user?.sub ?? ""))).toBeUndefined();
    expect(await deleteLead(deps(), EMAIL, "REQUEST")).toEqual({ users: 0, worldsDestroyed: 0 });
  });
});
