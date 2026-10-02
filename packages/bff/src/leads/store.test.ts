// The lead items of `Leads` (ADR-0015 §6): created once per email, merged on a new verified sign-up
// with the earlier consents in their history, `lastLoginAt` only forward, the contact consent withdrawn
// with its date, tombstones without personal data, and listings that never return a pending sign-up.
import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { createSignupStore } from "../signup/store";
import { LEADS_TABLE, tombKey } from "./lead";
import { type LeadStore, type VerifiedLeadInput, createLeadStore } from "./store";

const NOW = new Date("2026-10-14T13:30:00.000Z");
const HASH = "a".repeat(64);
const consent = { at: "2026-10-14T13:00:00.000Z", lang: "es" as const, version: "2026-10-02" };
const input = (overrides: Partial<VerifiedLeadInput> = {}): VerifiedLeadInput => ({
  newLeadId: "01J9ZQ00000000000000000001",
  email: "ana.gomez@despachos-del-sur.com.ar",
  emailHash: HASH,
  consents: { terms: { accepted: true, privacyVersion: "2026-10-02", ...consent }, contact: { accepted: false, ...consent } },
  language: "es",
  utm: {},
  signupAt: consent.at,
  confirmedAt: consent.at,
  cognitoUsername: "usr-01j9zq00000000000000000001",
  ...overrides,
});

let stores: MemoryStores;
let leads: LeadStore;

beforeEach(() => {
  stores = memoryStores();
  leads = createLeadStore(stores.client);
});

describe("Leads/EMAIL#…/LEAD", () => {
  it("is created once, then merged: new optional data and consents, the earlier ones in the history, the same leadId", async () => {
    expect((await leads.saveVerifiedLead(input(), NOW)).created).toBe(true);
    const merged = await leads.saveVerifiedLead(input({ newLeadId: "01J9ZQ00000000000000000002", company: "Despachos del Sur (ficticia)", consents: { ...input().consents, contact: { accepted: true, ...consent, at: "2026-10-14T13:20:00.000Z" } } }), NOW);
    expect(merged.created).toBe(false);
    expect(merged.lead).toMatchObject({ leadId: "01J9ZQ00000000000000000001", company: "Despachos del Sur (ficticia)", consents: { contact: { accepted: true } }, sourcePoc: "legajo-listo", noticeStatus: "PENDING" });
    expect(merged.lead.consentHistory).toEqual([
      { consent: "terms", accepted: true, privacyVersion: "2026-10-02", ...consent },
      { consent: "contact", accepted: false, ...consent },
    ]);
  });

  it("moves lastLoginAt only forward, and withdraws the contact consent with its date", async () => {
    await leads.saveVerifiedLead(input({ consents: { ...input().consents, contact: { accepted: true, ...consent } } }), NOW);
    expect(await leads.touchLastLogin(HASH, "2026-10-14T14:00:00.000Z", NOW)).toBe(true);
    expect(await leads.touchLastLogin(HASH, "2026-10-14T13:59:00.000Z", NOW)).toBe(false);
    expect(await leads.touchLastLogin("b".repeat(64), "2026-10-14T14:00:00.000Z", NOW)).toBe(false);
    const withdrawn = await leads.optOutContact(HASH, "2026-10-15T09:00:00.000Z", NOW);
    expect(withdrawn).toMatchObject({ lastLoginAt: "2026-10-14T14:00:00.000Z", consents: { contact: { accepted: false, at: "2026-10-15T09:00:00.000Z", version: "2026-10-02" } } });
    expect(withdrawn?.consentHistory.at(-1)).toEqual({ consent: "contact", accepted: false, at: "2026-10-15T09:00:00.000Z", version: "2026-10-02", lang: "es" });
  });

  it("lists leads only, and a tombstone keeps no personal data", async () => {
    await leads.saveVerifiedLead(input(), NOW);
    await createSignupStore(stores.client).create(
      { signupId: "01J9ZQXA7Q2W3E4R5T6Y7V8H9G", username: "usr-01j9zq00000000000000000002", email: "otra@despachos-del-sur.com.ar", emailHash: "c".repeat(64), consents: input().consents, language: "es", utm: {}, startedAt: NOW.toISOString(), honeypot: false },
      NOW,
    );
    expect((await leads.listLeads()).map((lead) => lead.emailHash)).toEqual([HASH]);
    await leads.delete(HASH);
    await leads.putTombstone({ leadId: "01J9ZQ00000000000000000001", deletedAt: NOW.toISOString(), reason: "REQUEST" }, NOW);
    expect(await leads.get(HASH)).toBeUndefined();
    const tomb = await stores.client.get(LEADS_TABLE, tombKey("01J9ZQ00000000000000000001"));
    expect(JSON.stringify(tomb)).not.toMatch(/despachos-del-sur|usr-|@/);
  });
});
