// FL-114, ADR-0015 §3.2: a permanent bounce or a complaint of an account email marks the recipient in
// `Runtime/MAILSTATUS#<emailHash>` whether a lead exists or not, counts in the hour, and opens the
// reputation breaker when the last 24 hours cross the threshold of guest-limits.ts (complaints by count,
// bounces only by rate). `Leads` is never touched; only the operator closes the breaker.
import { beforeEach, describe, expect, it } from "vitest";
import { MAIL_BREAKER } from "@legajo/shared/guest-limits";
import type { MemoryStores } from "../../connector/index";
import { memoryStores } from "../../connector/testing";
import { leadEmailHash } from "../../lib/crypto";
import { createLogger } from "../../lib/log";
import { LEADS_TABLE } from "../../leads/lead";
import { RUNTIME_TABLE, countWindowed } from "../../signup/counters";
import { testSignupKeys } from "../../signup/testing";
import { MAIL_TOTAL_BASE, closeBreaker, isBreakerOpen, markMailStatus, readBreaker, readMailStatus } from "./mail-status";

const keys = testSignupKeys();
let now: Date;
let stores: MemoryStores;
let lines: string[];

beforeEach(() => {
  now = new Date("2026-10-14T13:20:00.000Z");
  stores = memoryStores();
  lines = [];
});

const deps = () => ({ client: stores.client, leadEmailKey: keys.leadEmail, log: createLogger({ level: "debug", sink: (line) => lines.push(line) }), now: () => now });
const hash = (email: string) => leadEmailHash(keys.leadEmail, email);

describe("[FL-114] bounce state of a recipient", () => {
  it("marks a bounce of an email that never became a lead, without touching Leads", async () => {
    expect(await markMailStatus(deps(), { kind: "BOUNCE", recipients: ["Nadie@Despachos-Del-Sur.com.ar"] })).toEqual({ marked: 1, breakerOpened: false });
    expect(await readMailStatus(stores.client, hash("nadie@despachos-del-sur.com.ar"))).toEqual({ status: "BOUNCED", at: now.toISOString(), count: 1 });
    expect(stores.client.dump(LEADS_TABLE)).toEqual([]);
    expect(lines.join("\n")).not.toContain("despachos-del-sur");
  });

  it("a complaint is never downgraded by a later bounce", async () => {
    await markMailStatus(deps(), { kind: "COMPLAINT", recipients: ["ana@despachos-del-sur.com.ar"] });
    await markMailStatus(deps(), { kind: "BOUNCE", recipients: ["ana@despachos-del-sur.com.ar"] });
    expect(await readMailStatus(stores.client, hash("ana@despachos-del-sur.com.ar"))).toMatchObject({ status: "COMPLAINED", count: 2 });
  });
});

describe("[FL-114] the reputation breaker", () => {
  it("opens at the count of complaints of 24 hours, once, with the alarm's metric", async () => {
    for (let index = 0; index < MAIL_BREAKER.complaintCount - 1; index += 1) {
      now = new Date(now.getTime() + 3_600_000);
      expect((await markMailStatus(deps(), { kind: "COMPLAINT", recipients: [`r${index}@despachos-del-sur.com.ar`] })).breakerOpened).toBe(false);
    }
    expect(await isBreakerOpen(stores.client)).toBe(false);
    expect((await markMailStatus(deps(), { kind: "COMPLAINT", recipients: ["last@despachos-del-sur.com.ar"] })).breakerOpened).toBe(true);
    expect(await readBreaker(stores.client)).toMatchObject({ state: "OPEN", openedAt: now.toISOString() });
    expect((await markMailStatus(deps(), { kind: "BOUNCE", recipients: ["again@despachos-del-sur.com.ar"] })).breakerOpened).toBe(false);
    expect(lines.filter((line) => line.includes('"metric":"AccountMailBreakerOpen"'))).toHaveLength(1);
  });

  it("never opens on a count of bounces: ten codes to non-existent mailboxes of a real domain do not stop the product", async () => {
    // Fresh sign-ups to random addresses at a real domain: each code bounces (550 5.1.1).
    for (let index = 0; index < MAIL_BREAKER.complaintCount * 3; index += 1) await countWindowed(stores.client, MAIL_TOTAL_BASE, "DAY", now);
    for (let index = 0; index < MAIL_BREAKER.complaintCount * 2; index += 1) {
      expect((await markMailStatus(deps(), { kind: "BOUNCE", recipients: [`nadie${index}@gmail.com`] })).breakerOpened).toBe(false);
    }
    expect(await isBreakerOpen(stores.client)).toBe(false);
  });

  it("opens past the bad rate once enough emails went out, not before", async () => {
    const rateBad = Math.floor(MAIL_BREAKER.minSent * MAIL_BREAKER.badRate) + 1;
    for (let index = 0; index < rateBad; index += 1) await markMailStatus(deps(), { kind: "BOUNCE", recipients: [`early${index}@despachos-del-sur.com.ar`] });
    expect(await isBreakerOpen(stores.client)).toBe(false);
    for (let index = 0; index < MAIL_BREAKER.minSent; index += 1) await countWindowed(stores.client, MAIL_TOTAL_BASE, "DAY", now);
    await markMailStatus(deps(), { kind: "BOUNCE", recipients: ["r0@despachos-del-sur.com.ar"] });
    expect(rateBad).toBeLessThan(MAIL_BREAKER.complaintCount);
    expect(await isBreakerOpen(stores.client)).toBe(true);
  });

  it("complaints older than 24 hours do not count", async () => {
    for (let index = 0; index < MAIL_BREAKER.complaintCount - 1; index += 1) await markMailStatus(deps(), { kind: "COMPLAINT", recipients: [`old${index}@despachos-del-sur.com.ar`] });
    now = new Date(now.getTime() + 25 * 3_600_000);
    await markMailStatus(deps(), { kind: "COMPLAINT", recipients: ["new@despachos-del-sur.com.ar"] });
    expect(await isBreakerOpen(stores.client)).toBe(false);
  });

  it("only the operator closes it", async () => {
    for (let index = 0; index < MAIL_BREAKER.complaintCount; index += 1) await markMailStatus(deps(), { kind: "COMPLAINT", recipients: [`r${index}@despachos-del-sur.com.ar`] });
    expect(await isBreakerOpen(stores.client)).toBe(true);
    expect(await closeBreaker(stores.client, now)).toEqual({ state: "CLOSED", closedAt: now.toISOString() });
    expect(await isBreakerOpen(stores.client)).toBe(false);
    expect(stores.client.dump(RUNTIME_TABLE).some((row) => row.PK === "MAILBREAKER")).toBe(true);
  });
});
