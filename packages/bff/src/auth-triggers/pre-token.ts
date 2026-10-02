// Cognito pre token generation trigger, event version V2_0 (infra/auth.ts `AuthPreToken`, which
// links only `Firms`). On every sign-in and every refresh it stamps into the id token what the BFF
// and the console read (auth/principal.ts, packages/web/src/lib/auth-claims.ts):
//
//   custom:firmId      staff: the tenant the invitation set (re-stamped once validated); a GUEST: only
//                      the firm of its own broker row (`Firms/BROKER#`, GSI1 `SUB#<sub>`), never the
//                      user attribute, so a guest without a world gets a token without a firm, good only
//                      for `guestBootstrapProcedure` (ADR-0015 §4)
//   custom:role        from the broker row the user's `sub` is bound to, else the highest-precedence
//                      console group
//   custom:isGuest     "true" for a GUEST, who acts as a broker only inside its own guest firm
//   custom:worldLease  a GUEST's: the lease of the world its broker row was written for; the BFF
//                      refuses a token whose lease is no longer the row's (403 `GUEST_WORLD_GONE`)
//
// A guest's access token, and every refused one, also loses the `aws.cognito.signin.user.admin` scope:
// guest accounts must not change their password, MFA or attributes with it (ADR-0014 §7, ADR-0015 §1),
// so Cognito itself refuses ChangePassword, AssociateSoftwareToken, SetUserMFAPreference,
// UpdateUserAttributes and DeleteUser with it. SRP sign-in, refresh and RevokeToken do not need it.
//
// The groups are copied back unchanged: a V2_0 response that leaves `groupOverrideDetails` empty
// suppresses them. An account that cannot be resolved (no valid firm, no console role, an inactive
// broker, a guest outside a guest firm) gets a token without tenant, role or groups, which the BFF
// refuses (PRINCIPAL_INCOMPLETE) and the console shows as "no access". A broker directory that
// cannot be read fails the sign-in: Cognito waits at most 5 s, so the read has its own deadline.
import { FirmId } from "@legajo/shared";
import { z } from "zod";
import { describeError } from "../auth/errors";
import { WORLD_LEASE_CLAIM, consoleRolesOf, isGuestFirm, resolveAccess, type AccessRefusal, type GuestRow } from "../auth/principal";
import { brokerLookupOf, type BrokerLookup } from "../auth/staff";
import { type TableClient, connector, tableClient } from "../connector/index";
import { Broker } from "../domain/firms";
import { withDeadline } from "../lib/deadline";
import { createLogger, type Logger } from "../lib/log";

/** Claims this trigger owns in the id token. */
export const STAMPED_CLAIMS = { firmId: "custom:firmId", role: "custom:role", isGuest: "custom:isGuest", worldLease: WORLD_LEASE_CLAIM } as const;

// What the trigger reads of the event; everything else Cognito sends passes through untouched.
const GroupConfiguration = z.looseObject({
  groupsToOverride: z.array(z.string()).optional(),
  iamRolesToOverride: z.array(z.string()).optional(),
  preferredRole: z.unknown().optional(),
});

export const PreTokenEvent = z.looseObject({
  version: z.string(),
  triggerSource: z.string().min(1),
  userPoolId: z.string().min(1),
  userName: z.string().min(1),
  request: z.looseObject({
    userAttributes: z.record(z.string(), z.string()),
    groupConfiguration: GroupConfiguration,
  }),
  response: z.unknown().optional(),
});
export type PreTokenEvent = z.infer<typeof PreTokenEvent>;

export type ClaimValue = string;

/** The scope that lets an access token call Cognito's self-service account API. */
export const ACCOUNT_ADMIN_SCOPE = "aws.cognito.signin.user.admin";

/** `response.claimsAndScopeOverrideDetails` of a V2_0 event. */
export interface ClaimsAndScopeOverrideDetails {
  readonly idTokenGeneration: {
    readonly claimsToAddOrOverride?: Readonly<Record<string, ClaimValue>>;
    readonly claimsToSuppress?: readonly string[];
  };
  readonly accessTokenGeneration?: {
    readonly scopesToSuppress?: readonly string[];
  };
  readonly groupOverrideDetails: z.infer<typeof GroupConfiguration>;
}

export type PreTokenRefusal = AccessRefusal | "NO_SUB" | "BROKER_INACTIVE" | "AMBIGUOUS_GUEST";

export type PreTokenDecision =
  | { readonly outcome: "STAMPED"; readonly details: ClaimsAndScopeOverrideDetails }
  | { readonly outcome: "REFUSED"; readonly refusal: PreTokenRefusal; readonly details: ClaimsAndScopeOverrideDetails };

/**
 * No tenant and no groups in either token: the account has no access. Role and guest flag are
 * simply not stamped; only claims the pool really issues are suppressed (`custom:firmId` is a pool
 * attribute), and empty group overrides clear `cognito:groups` in the id and access tokens. The
 * access token also loses the account scope: a refused guest (ambiguous, inactive or misplaced row)
 * or a self-service account left without its group must not reach Cognito's account API either, and
 * a token with no access needs none of it.
 */
const REFUSED_DETAILS: ClaimsAndScopeOverrideDetails = {
  idTokenGeneration: { claimsToSuppress: [STAMPED_CLAIMS.firmId] },
  accessTokenGeneration: { scopesToSuppress: [ACCOUNT_ADMIN_SCOPE] },
  groupOverrideDetails: { groupsToOverride: [] },
};

function refused(refusal: PreTokenRefusal): PreTokenDecision {
  return { outcome: "REFUSED", refusal, details: REFUSED_DETAILS };
}

/** A guest's broker rows by its `sub`, in any firm (`Firms` GSI1 `SUB#<sub>`). */
export type GuestRowsLookup = (sub: string) => Promise<GuestRow[]>;

/** The lookup over the raw `Firms` rows (the broker row keeps `leaseId`, written with the world). */
export function guestRowsOf(client: TableClient): GuestRowsLookup {
  return async (sub) => {
    const rows = await client.query("Firms", { index: "GSI1", hashValue: `SUB#${sub}`, filter: { equals: { entity: "Broker" } }, limit: 5 });
    return rows.flatMap((row) => {
      const broker = Broker.safeParse(row);
      return broker.success ? [{ firmId: broker.data.firmId, active: broker.data.active, ...(broker.data.leaseId === undefined ? {} : { leaseId: broker.data.leaseId }) }] : [];
    });
  };
}

export interface PreTokenDeps {
  readonly brokers: BrokerLookup;
  readonly guestRows: GuestRowsLookup;
  readonly log: Logger;
  /** Deadline of the broker read; Cognito gives the whole trigger 5 s. */
  readonly lookupTimeoutMs?: number;
}

const LOOKUP_TIMEOUT_MS = 3_500;

const GUEST_SCOPE = { accessTokenGeneration: { scopesToSuppress: [ACCOUNT_ADMIN_SCOPE] } } as const;

/** A GUEST: the firm and lease of its own broker row, or no firm at all (ADR-0015 §4). */
async function decideGuest(sub: string, groupConfiguration: PreTokenEvent["request"]["groupConfiguration"], deps: PreTokenDeps): Promise<PreTokenDecision> {
  const rows = await withDeadline("pre-token guest lookup", deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, () => deps.guestRows(sub));
  const guest = { [STAMPED_CLAIMS.role]: "GUEST", [STAMPED_CLAIMS.isGuest]: "true" };
  if (rows.length === 0) {
    return { outcome: "STAMPED", details: { idTokenGeneration: { claimsToAddOrOverride: guest, claimsToSuppress: [STAMPED_CLAIMS.firmId] }, ...GUEST_SCOPE, groupOverrideDetails: groupConfiguration } };
  }
  const [row] = rows;
  if (rows.length > 1 || row === undefined) return refused("AMBIGUOUS_GUEST");
  if (!row.active) return refused("BROKER_INACTIVE");
  if (!isGuestFirm(row.firmId)) return refused("GUEST_OUTSIDE_GUEST_FIRM");
  const claims = { ...guest, [STAMPED_CLAIMS.firmId]: row.firmId, ...(row.leaseId === undefined ? {} : { [STAMPED_CLAIMS.worldLease]: row.leaseId }) };
  return { outcome: "STAMPED", details: { idTokenGeneration: { claimsToAddOrOverride: claims }, ...GUEST_SCOPE, groupOverrideDetails: groupConfiguration } };
}

/** The overrides for one token issuance. Rejects only when the broker directory cannot be read. */
export async function decidePreToken(event: PreTokenEvent, deps: PreTokenDeps): Promise<PreTokenDecision> {
  const { userAttributes, groupConfiguration } = event.request;
  const sub = userAttributes.sub;
  if (sub === undefined || sub === "") return refused("NO_SUB");
  if (consoleRolesOf(groupConfiguration.groupsToOverride)[0] === "GUEST") return decideGuest(sub, groupConfiguration, deps);

  const firm = FirmId.safeParse(userAttributes[STAMPED_CLAIMS.firmId]);
  if (!firm.success) return refused("NO_FIRM");
  const firmId = firm.data;

  const row = await withDeadline("pre-token broker lookup", deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, () => deps.brokers.findBySub(firmId, sub));
  if (row !== undefined && !row.active) return refused("BROKER_INACTIVE");

  const resolved = resolveAccess({ firmId, role: row?.role, groups: groupConfiguration.groupsToOverride });
  if (!resolved.ok) return refused(resolved.refusal);
  const { role, isGuest } = resolved.access;

  return {
    outcome: "STAMPED",
    details: {
      idTokenGeneration: {
        claimsToAddOrOverride: { [STAMPED_CLAIMS.firmId]: firmId, [STAMPED_CLAIMS.role]: role, [STAMPED_CLAIMS.isGuest]: isGuest ? "true" : "false" },
      },
      ...(isGuest ? { accessTokenGeneration: { scopesToSuppress: [ACCOUNT_ADMIN_SCOPE] } } : {}),
      groupOverrideDetails: groupConfiguration,
    },
  };
}

export type PreTokenHandler = (event: unknown) => Promise<unknown>;

/** The Lambda over explicit dependencies; returns the event with its response filled in. */
export function createPreTokenHandler(resolveDeps: () => PreTokenDeps): PreTokenHandler {
  return async (raw) => {
    const deps = resolveDeps();
    const parsed = PreTokenEvent.safeParse(raw);
    if (!parsed.success) {
      deps.log.error("auth.pretoken.invalid_event", { issues: parsed.error.issues.length });
      throw new Error("pre token generation event has an unexpected shape");
    }
    const event = parsed.data;
    let decision: PreTokenDecision;
    try {
      decision = await decidePreToken(event, deps);
    } catch (error) {
      // Fails the sign-in: a token must not be issued without the broker row having been checked.
      deps.log.error("auth.pretoken.lookup_failed", { triggerSource: event.triggerSource, ...describeError(error) });
      throw new Error("could not resolve the console access of this user");
    }
    const fields = { triggerSource: event.triggerSource, outcome: decision.outcome };
    if (decision.outcome === "REFUSED") deps.log.warn("auth.pretoken.refused", { ...fields, refusal: decision.refusal });
    else deps.log.info("auth.pretoken.stamped", fields);
    return { ...event, response: { claimsAndScopeOverrideDetails: decision.details } };
  };
}

let defaults: PreTokenDeps | undefined;

// One set per container; the `Firms` table name is read from its link on the first query.
function defaultDeps(): PreTokenDeps {
  defaults ??= {
    brokers: brokerLookupOf(connector().firms),
    guestRows: guestRowsOf(tableClient()),
    log: createLogger({ bindings: { service: "auth-pre-token" } }),
  };
  return defaults;
}

export const handler: PreTokenHandler = createPreTokenHandler(defaultDeps);
