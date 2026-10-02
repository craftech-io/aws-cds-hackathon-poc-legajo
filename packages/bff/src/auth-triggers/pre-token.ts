// Cognito pre token generation trigger, event version V2_0 (infra/auth.ts `AuthPreToken`, which
// links only `Firms`). On every sign-in and every refresh it stamps into the id token what the BFF
// and the console read (auth/principal.ts, packages/web/src/lib/auth-claims.ts):
//
//   custom:firmId   the tenant the invitation set (re-stamped once validated)
//   custom:role     from the broker row the user's `sub` is bound to (`Firms/BROKER#`, GSI1), else
//                   the highest-precedence console group (a guest's first sign-in, before its world
//                   and its broker row exist)
//   custom:isGuest  "true" for a GUEST, who acts as a broker only inside its own guest firm
//
// A guest's access token also loses the `aws.cognito.signin.user.admin` scope: guest accounts are
// shared through the private Devpost instructions, so Cognito itself must refuse ChangePassword,
// AssociateSoftwareToken, SetUserMFAPreference, UpdateUserAttributes and DeleteUser with it (hiding
// them in the console is not enough; docs/design-brief.md §7.1). SRP sign-in, refresh and
// RevokeToken do not need that scope.
//
// The groups are copied back unchanged: a V2_0 response that leaves `groupOverrideDetails` empty
// suppresses them. An account that cannot be resolved (no valid firm, no console role, an inactive
// broker, a guest outside a guest firm) gets a token without tenant, role or groups, which the BFF
// refuses (PRINCIPAL_INCOMPLETE) and the console shows as "no access". A broker directory that
// cannot be read fails the sign-in: Cognito waits at most 5 s, so the read has its own deadline.
import { FirmId } from "@legajo/shared";
import { z } from "zod";
import { describeError } from "../auth/errors";
import { resolveAccess, type AccessRefusal } from "../auth/principal";
import { brokerLookupOf, type BrokerLookup } from "../auth/staff";
import { connector } from "../connector/index";
import { withDeadline } from "../lib/deadline";
import { createLogger, type Logger } from "../lib/log";

/** Claims this trigger owns in the id token. */
export const STAMPED_CLAIMS = { firmId: "custom:firmId", role: "custom:role", isGuest: "custom:isGuest" } as const;

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

export type PreTokenRefusal = AccessRefusal | "NO_SUB" | "BROKER_INACTIVE";

export type PreTokenDecision =
  | { readonly outcome: "STAMPED"; readonly details: ClaimsAndScopeOverrideDetails }
  | { readonly outcome: "REFUSED"; readonly refusal: PreTokenRefusal; readonly details: ClaimsAndScopeOverrideDetails };

/**
 * No tenant and no groups in either token: the account has no access. Role and guest flag are
 * simply not stamped; only claims the pool really issues are suppressed (`custom:firmId` is a pool
 * attribute), and empty group overrides clear `cognito:groups` in the id and access tokens.
 */
const REFUSED_DETAILS: ClaimsAndScopeOverrideDetails = {
  idTokenGeneration: { claimsToSuppress: [STAMPED_CLAIMS.firmId] },
  groupOverrideDetails: { groupsToOverride: [] },
};

function refused(refusal: PreTokenRefusal): PreTokenDecision {
  return { outcome: "REFUSED", refusal, details: REFUSED_DETAILS };
}

export interface PreTokenDeps {
  readonly brokers: BrokerLookup;
  readonly log: Logger;
  /** Deadline of the broker read; Cognito gives the whole trigger 5 s. */
  readonly lookupTimeoutMs?: number;
}

const LOOKUP_TIMEOUT_MS = 3_500;

/** The overrides for one token issuance. Rejects only when the broker directory cannot be read. */
export async function decidePreToken(event: PreTokenEvent, deps: PreTokenDeps): Promise<PreTokenDecision> {
  const { userAttributes, groupConfiguration } = event.request;
  const sub = userAttributes.sub;
  if (sub === undefined || sub === "") return refused("NO_SUB");

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
    log: createLogger({ bindings: { service: "auth-pre-token" } }),
  };
  return defaults;
}

export const handler: PreTokenHandler = createPreTokenHandler(defaultDeps);
