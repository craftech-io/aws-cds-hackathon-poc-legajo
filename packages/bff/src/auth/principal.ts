// The principal of a console request `{sub, brokerId, firmId, role, isJudge, authTime}`
// (docs/architecture.md §10). Every field comes from the verified id token or from the broker row
// the token's `sub` is bound to, never from the request input: `custom:firmId` is set by the
// invitation and is not writable by the web client (infra/auth.ts); role and `isJudge` are stamped
// by the pre-token trigger from `Firms/BROKER#` (auth-triggers/pre-token.ts), which resolves them
// with the same `resolveAccess` as the BFF.
import { ConsoleRole, FirmId, QaConsoleRole } from "@legajo/shared";
import { AUTH_REASON, AuthError } from "./errors";
import type { IdTokenClaims } from "./jwt";
import type { BrokerMatch } from "./staff";

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
  /** `origin_jti` of the sign-in: the same across refreshes, another one for another session. */
  readonly originJti?: string;
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

// `firm-judge-01..NN` and `firm-judge-test` (docs/seed-spec.md §2).
const JUDGE_FIRM = /^firm-judge-[a-z0-9]+$/;

/** A judge acts as a broker only inside its own judge firm, never in a demo or QA firm of the operator. */
export function isJudgeFirm(firmId: string): boolean {
  return JUDGE_FIRM.test(firmId);
}

export interface AccessInput {
  /** `custom:firmId` of the user. */
  readonly firmId: unknown;
  /** Role stamped in the token (`custom:role`) or read from the broker row. */
  readonly role?: unknown;
  /** Cognito groups of the user; the highest-precedence console group is the role when none is stamped. */
  readonly groups?: readonly string[];
  /** `custom:isJudge` as the token carries it. */
  readonly isJudgeClaim?: unknown;
}

export interface Access {
  readonly firmId: FirmId;
  readonly role: ConsoleRole;
  readonly groups: readonly ConsoleRole[];
  readonly isJudge: boolean;
}

export type AccessRefusal = "NO_FIRM" | "NO_ROLE" | "JUDGE_OUTSIDE_JUDGE_FIRM";

export type AccessResolution = { readonly ok: true; readonly access: Access } | { readonly ok: false; readonly refusal: AccessRefusal };

/**
 * Firm, role and `isJudge` of a user: the explicit role wins, otherwise the highest-precedence
 * group (the console draws its menu the same way, packages/web/src/lib/auth-claims.ts). An account
 * that would be a judge outside a judge firm is refused: a misplaced invitation must not give broker
 * powers over another firm's demo.
 */
export function resolveAccess(input: AccessInput): AccessResolution {
  const firmId = FirmId.safeParse(input.firmId);
  if (!firmId.success) return { ok: false, refusal: "NO_FIRM" };
  const groups = consoleRolesOf(input.groups);
  const explicit = ConsoleRole.safeParse(input.role);
  const role = explicit.success ? explicit.data : groups[0];
  if (role === undefined) return { ok: false, refusal: "NO_ROLE" };
  const isJudge = role === "JUDGE" || input.isJudgeClaim === "true";
  if (isJudge && !isJudgeFirm(firmId.data)) return { ok: false, refusal: "JUDGE_OUTSIDE_JUDGE_FIRM" };
  return { ok: true, access: { firmId: firmId.data, role, groups, isJudge } };
}

const REFUSAL_MESSAGE: Readonly<Record<AccessRefusal, string>> = {
  NO_FIRM: "the token carries no firm",
  NO_ROLE: "the token carries no console role",
  JUDGE_OUTSIDE_JUDGE_FIRM: "a judge account only works inside its own judge firm",
};

function requireAccess(input: AccessInput): Access {
  const resolved = resolveAccess(input);
  if (!resolved.ok) throw new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, REFUSAL_MESSAGE[resolved.refusal]);
  return resolved.access;
}

export function principalFromClaims(claims: IdTokenClaims): Principal {
  const access = requireAccess({
    firmId: claims["custom:firmId"],
    role: claims["custom:role"],
    groups: claims["cognito:groups"],
    isJudgeClaim: claims["custom:isJudge"],
  });
  const originJti = claims.origin_jti;
  return { sub: claims.sub, username: claims["cognito:username"], authTime: claims.auth_time, ...access, ...(originJti === undefined ? {} : { originJti }) };
}

/**
 * The principal once the broker directory matched its `sub` (routers/trpc.ts `firmProcedure`): the
 * row gives the `brokerId` that signs the audit log and, being fresher than a token that lives 15
 * minutes, the role and the `active` switch.
 */
export function withBrokerRow(principal: Principal, match: BrokerMatch | undefined): Principal {
  if (match === undefined) return principal;
  if (!match.active) throw new AuthError(AUTH_REASON.BROKER_INACTIVE, "this broker account is no longer active");
  const access = requireAccess({ firmId: principal.firmId, role: match.role, groups: principal.groups });
  return { ...principal, ...access, brokerId: match.brokerId };
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

/** The firm-qa user the `QaDriver` acts as (docs/tool-catalog.md "Acciones del QaDriver"). */
export const QA_PRINCIPAL = {
  sub: "qa",
  firmId: "firm-qa",
  brokerIds: { BROKER: "brk-qa-runner", ANALYST: "brk-qa-analyst" },
} as const satisfies { sub: string; firmId: FirmId; brokerIds: Record<QaConsoleRole, string> };

export interface QaPrincipalInput {
  readonly role: QaConsoleRole;
  /** Last sign-in the scenario wants to exercise (an old one makes `recentLoginProcedure` refuse). */
  readonly authTime?: Date;
  /** Real time of the call. */
  readonly now: Date;
}

/**
 * Principal built on the server for `appRouter.createCaller` (the `QaDriver`'s `console.*` actions):
 * every middleware still runs on it (firm fence, role, recent login); only the JWT signature is
 * skipped, and that is proven by the unit and UI levels and by the real sign-in of `SC-24`.
 */
export function qaPrincipal(input: QaPrincipalInput): Principal {
  const role = QaConsoleRole.parse(input.role);
  const authTime = input.authTime ?? input.now;
  return {
    sub: QA_PRINCIPAL.sub,
    username: QA_PRINCIPAL.sub,
    firmId: QA_PRINCIPAL.firmId,
    role,
    groups: [role],
    isJudge: false,
    authTime: Math.floor(authTime.getTime() / 1000),
    brokerId: QA_PRINCIPAL.brokerIds[role],
  };
}
