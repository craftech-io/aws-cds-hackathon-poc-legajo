// Test-only world of the lead scripts: the in-memory connector and the sign-up doubles of
// packages/bff/src/signup/testing.ts, and leads written the way `finalizeSignup` writes them.
import { memoryStores } from "../../packages/bff/src/connector/testing";
import { leadEmailHash } from "../../packages/bff/src/lib/crypto";
import type { VerifiedLeadInput } from "../../packages/bff/src/leads/store";
import { type TestAccess, testAccessDeps } from "../../packages/bff/src/signup/testing";
import type { LeadScriptDeps } from "./common";

export const NOW = new Date("2026-10-14T13:30:00.000Z");

export interface LeadsWorld {
  readonly access: TestAccess;
  readonly deps: LeadScriptDeps;
  addLead(email: string, overrides?: Partial<VerifiedLeadInput>): Promise<void>;
}

let sequence = 0;

export function leadsWorld(): LeadsWorld {
  const stores = memoryStores();
  const access = testAccessDeps(stores, { now: () => NOW });
  const deps: LeadScriptDeps = { client: stores.client, leads: access.leads, signups: access.signups, cognito: access.cognito, invoker: access.invoker, leadEmailKey: access.keys.leadEmail, now: () => NOW };
  return {
    access,
    deps,
    async addLead(email, overrides = {}) {
      const consent = { at: "2026-10-10T12:00:00.000Z", lang: "es" as const, version: "2026-10-02" };
      sequence += 1;
      await access.leads.saveVerifiedLead(
        {
          newLeadId: `01J9ZQ${String(sequence).padStart(20, "0")}`,
          email,
          emailHash: leadEmailHash(access.keys.leadEmail, email),
          consents: { terms: { accepted: true, privacyVersion: "2026-10-02", ...consent }, contact: { accepted: true, ...consent } },
          language: "es",
          utm: {},
          signupAt: consent.at,
          confirmedAt: consent.at,
          cognitoUsername: `usr-${String(sequence).padStart(26, "0")}`,
          ...overrides,
        },
        NOW,
      );
    },
  };
}
