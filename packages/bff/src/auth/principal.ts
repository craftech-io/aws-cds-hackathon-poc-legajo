// The principal of a console request. Every field comes from the verified id token, never from the
// request input (docs/architecture.md §10): `custom:firmId` is set by the invitation and is not
// writable by the web client (infra/auth.ts); role and `isJudge` are stamped by the pre-token
// trigger from `Firms/BROKER#`.
import { z } from "zod";
import { ConsoleRole } from "@legajo/shared";
import { AUTH_REASON, AuthError } from "./errors";
import type { IdTokenClaims } from "./jwt";

/** Firm ids are `firm-<slug>` (docs/seed-spec.md §2). */
export const FirmId = z.string().regex(/^firm-[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type FirmId = z.infer<typeof FirmId>;

export interface Principal {
  /** Cognito `sub`: stable id of the user in the pool. */
  readonly sub: string;
  /** Cognito username, the handle AdminGetUser expects. */
  readonly username: string;
  /** The only firm this user may read or write. */
  readonly firmId: FirmId;
  readonly role: ConsoleRole;
  readonly groups: readonly ConsoleRole[];
  /** Judge accounts act as brokers inside their own judge firm, without TOTP or password change. */
  readonly isJudge: boolean;
  /** Epoch seconds of the last interactive sign-in (`auth_time`). */
  readonly authTime: number;
  /** Broker behind the user, once the broker directory has matched the `sub`. */
  readonly brokerId?: string;
}

// `ConsoleRole` is declared in precedence order, BROKER first.
const ROLE_PRECEDENCE: readonly ConsoleRole[] = ConsoleRole.options;

/** Cognito group names that are console roles, highest precedence first. */
export function consoleRolesOf(groupNames: readonly string[] | undefined): ConsoleRole[] {
  return (groupNames ?? [])
    .flatMap((group) => {
      const parsed = ConsoleRole.safeParse(group);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((a, b) => ROLE_PRECEDENCE.indexOf(a) - ROLE_PRECEDENCE.indexOf(b));
}

/**
 * Same resolution the console uses to draw its menu (packages/web/src/lib/auth-claims.ts): the
 * explicit `custom:role` wins, otherwise the highest-precedence group.
 */
export function principalFromClaims(claims: IdTokenClaims): Principal {
  const firmId = FirmId.safeParse(claims["custom:firmId"]);
  if (!firmId.success) {
    throw new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, "the token carries no firm");
  }
  const groups = consoleRolesOf(claims["cognito:groups"]);
  const explicitRole = ConsoleRole.safeParse(claims["custom:role"]);
  const role = explicitRole.success ? explicitRole.data : groups[0];
  if (!role) {
    throw new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, "the token carries no console role");
  }
  return {
    sub: claims.sub,
    username: claims["cognito:username"],
    firmId: firmId.data,
    role,
    groups,
    isJudge: role === "JUDGE" || claims["custom:isJudge"] === "true",
    authTime: claims.auth_time,
  };
}

/** How long after an interactive sign-in approving and reopening a file stay open (ADR-0010). */
export const RECENT_LOGIN_MAX_AGE_SECONDS = 15 * 60;

// Tolerated clock difference between Cognito and the Lambda.
const CLOCK_SKEW_SECONDS = 60;

/** True while the last interactive sign-in is inside the recent-login window. */
export function isSignInFresh(principal: Pick<Principal, "authTime">, now: Date, maxAgeSeconds: number = RECENT_LOGIN_MAX_AGE_SECONDS): boolean {
  const ageSeconds = Math.floor(now.getTime() / 1000) - principal.authTime;
  return ageSeconds >= -CLOCK_SKEW_SECONDS && ageSeconds <= maxAgeSeconds;
}
