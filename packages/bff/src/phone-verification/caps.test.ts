// The SMS limits of ADR-0021 (SMS_LIMITS): per account, per number, per viewer IP, in total and the
// foreign quota of the numbers outside the home region, each
// counted atomically with the windowed counters of the sign-up; a refusal names its limit, the send
// sends nothing and the screen gets `RATE_LIMITED`.
import { beforeEach, describe, expect, it } from "vitest";
import { SMS_LIMITS } from "@legajo/shared/guest-limits";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { createLogger } from "../lib/log";
import { RUNTIME_TABLE, counterKey } from "../signup/counters";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { consumeSms } from "./caps";
import { sendPhoneCode } from "./service";
import { phoneAccount } from "./testing";

const log = createLogger({ level: "error" });
let now: Date;
let stores: MemoryStores;
let access: TestAccess;

beforeEach(() => {
  now = new Date("2026-10-14T13:30:00.000Z");
  stores = memoryStores();
  access = testAccessDeps(stores, { now: () => now });
});

const keys = (overrides: Partial<{ sub: string; phoneHash: string; ipHash: string; home: boolean }> = {}) => ({ sub: "sub-a", phoneHash: "a".repeat(64), ipHash: "ip-a", home: true, ...overrides });
const hex = (index: number) => index.toString(16).padStart(64, "0");
const consumeTimes = async (count: number, make: (index: number) => ReturnType<typeof keys>) => {
  for (let index = 0; index < count; index += 1) expect((await consumeSms(stores.client, make(index), now)).ok).toBe(true);
};

describe("[FL-134] SMS limits", () => {
  it("six a day per account (enrolment and sign-ins together)", async () => {
    await consumeTimes(SMS_LIMITS.perAccount[0].limit, (index) => keys({ phoneHash: String(index).repeat(64).slice(0, 64), ipHash: `ip-${index}` }));
    expect(await consumeSms(stores.client, keys({ phoneHash: "f".repeat(64), ipHash: "ip-x" }), now)).toEqual({ ok: false, limit: "perAccount", retryAfterSec: 10.5 * 3600 });
  });

  it("three a day per number", async () => {
    await consumeTimes(SMS_LIMITS.perNumber[0].limit, (index) => keys({ sub: `sub-${index}`, ipHash: `ip-${index}` }));
    expect(await consumeSms(stores.client, keys({ sub: "sub-x", ipHash: "ip-x" }), now)).toMatchObject({ ok: false, limit: "perNumber" });
  });

  it("five a day per viewer IP", async () => {
    await consumeTimes(SMS_LIMITS.perIp[0].limit, (index) => keys({ sub: `sub-${index}`, phoneHash: String(index).repeat(64).slice(0, 64) }));
    expect(await consumeSms(stores.client, keys({ sub: "sub-x", phoneHash: "f".repeat(64) }), now)).toMatchObject({ ok: false, limit: "perIp" });
  });

  it(`${SMS_LIMITS.total[0].limit} a day in the whole demo`, async () => {
    await stores.client.put(RUNTIME_TABLE, { ...counterKey("RL#SMS#TOTAL", "DAY", now), entity: "WindowCounter", count: SMS_LIMITS.total[0].limit, version: 1 });
    expect(await consumeSms(stores.client, keys(), now)).toMatchObject({ ok: false, limit: "total" });
  });

  it(`numbers outside the home region share ${SMS_LIMITS.foreign[0].limit} a day in the whole demo: the next one is refused`, async () => {
    const foreign = SMS_LIMITS.foreign[0].limit;
    await consumeTimes(foreign, (index) => keys({ sub: `sub-${index}`, phoneHash: hex(index), ipHash: `ip-${index}`, home: false }));
    expect(await consumeSms(stores.client, keys({ sub: "sub-x", phoneHash: hex(99), ipHash: "ip-x", home: false }), now)).toEqual({ ok: false, limit: "foreign", retryAfterSec: 10.5 * 3600 });
    expect(await consumeSms(stores.client, keys({ sub: "sub-y", phoneHash: hex(98), ipHash: "ip-y" }), now)).toEqual({ ok: true });
  });

  it("a home number never counts in the foreign quota", async () => {
    await consumeTimes(SMS_LIMITS.foreign[0].limit + 2, (index) => keys({ sub: `sub-${index}`, phoneHash: hex(index), ipHash: `ip-${index}` }));
    expect(await stores.client.get(RUNTIME_TABLE, counterKey("RL#SMS#FOREIGN", "DAY", now))).toBeUndefined();
    expect(await consumeSms(stores.client, keys({ sub: "sub-x", phoneHash: hex(99), ipHash: "ip-x", home: false }), now)).toEqual({ ok: true });
  });

  it("the sixth SMS to numbers outside the region is refused by sendPhoneCode with the foreign limit, and nothing is sent", async () => {
    const foreign = SMS_LIMITS.foreign[0].limit;
    for (let index = 0; index < foreign; index += 1) {
      expect(await sendPhoneCode(access, phoneAccount({ username: `usr-${index}`, ipHash: `ip-${index}` }), `+1202555010${index}`, log)).toMatchObject({ status: "CODE_SENT" });
    }
    expect(await sendPhoneCode(access, phoneAccount({ username: "usr-x", ipHash: "ip-x" }), "+12025550199", log)).toMatchObject({ status: "RATE_LIMITED", limit: "foreign" });
    expect(access.sms.sent).toHaveLength(foreign);
    expect(await sendPhoneCode(access, phoneAccount({ username: "usr-ar", ipHash: "ip-ar" }), "+5491155550101", log)).toMatchObject({ status: "CODE_SENT" });
  });

  it("a refused send counts in no window and sends nothing; the next day it works again", async () => {
    await stores.client.put(RUNTIME_TABLE, { ...counterKey("RL#SMS#TOTAL", "DAY", now), entity: "WindowCounter", count: SMS_LIMITS.total[0].limit, version: 1 });
    const account = phoneAccount({ username: "usr-ana" });
    expect(await sendPhoneCode(access, account, "+5491155550101", log)).toEqual({ status: "RATE_LIMITED", limit: "total", retryAfterSec: 10.5 * 3600 });
    expect(access.sms.sent).toEqual([]);
    expect(await stores.client.get(RUNTIME_TABLE, counterKey(`RL#SMS#ACCOUNT#${account.sub}`, "DAY", now))).toBeUndefined();
    now = new Date("2026-10-15T00:00:01.000Z");
    expect(await sendPhoneCode(access, account, "+5491155550101", log)).toMatchObject({ status: "CODE_SENT" });
  });
});
