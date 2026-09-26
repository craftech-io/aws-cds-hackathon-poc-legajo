// Reads the principal out of the Cognito id token. The console only decodes the payload: the
// signature is verified by the BFF on every call, and the JWT is the only source of `firmId` and
// role (docs/design-brief.md §6). The claims are the ones packages/bff/src/auth/principal.ts reads:
// `custom:firmId` from the invitation, `custom:role` and `custom:isJudge` from the pre-token trigger,
// the Cognito groups, `cognito:username` (a judge signs in with it: judges have no email) and
// `auth_time`. Nothing here trusts user input.
import { ConsoleRole, FirmId } from "@legajo/shared";
import { z } from "zod";

const IdTokenClaimsSchema = z.looseObject({
  sub: z.string().min(1),
  iss: z.string().min(1),
  aud: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
  token_use: z.literal("id"),
  auth_time: z.number().int().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  "cognito:username": z.string().min(1).optional(),
  "custom:firmId": z.string().min(1).optional(),
  "custom:role": z.string().optional(),
  "custom:isJudge": z.string().optional(),
  "cognito:groups": z.array(z.string()).optional(),
});

export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;

export interface Principal {
  readonly sub: string;
  /** Cognito username: what a judge types to sign in (`judge-01`). */
  readonly username?: string;
  readonly email?: string;
  readonly name?: string;
  /** Firm the user belongs to; absent until the invitation assigns a valid one. */
  readonly firmId?: string;
  readonly role?: ConsoleRole;
  readonly groups: readonly ConsoleRole[];
  /** A judge acts as a broker inside its own judge firm, without TOTP or password change. */
  readonly isJudge: boolean;
  /** Epoch milliseconds of the last interactive sign-in. */
  readonly authTime?: number;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

// Precedence of the Cognito groups: the enum is declared in precedence order, BROKER first.
const ROLE_PRECEDENCE: readonly ConsoleRole[] = ConsoleRole.options;

function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function decodeJwtPayload(token: string): unknown {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("malformed JWT");
  return JSON.parse(decodeBase64Url(payload)) as unknown;
}

export function parseIdTokenClaims(token: string): IdTokenClaims {
  return IdTokenClaimsSchema.parse(decodeJwtPayload(token));
}

function groupsOf(claims: IdTokenClaims): ConsoleRole[] {
  return (claims["cognito:groups"] ?? [])
    .map((group) => ConsoleRole.safeParse(group))
    .flatMap((result) => (result.success ? [result.data] : []))
    .sort((a, b) => ROLE_PRECEDENCE.indexOf(a) - ROLE_PRECEDENCE.indexOf(b));
}

function roleOf(claims: IdTokenClaims, groups: readonly ConsoleRole[]): ConsoleRole | undefined {
  const explicit = ConsoleRole.safeParse(claims["custom:role"]);
  if (explicit.success) return explicit.data;
  return groups[0];
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export function principalFromClaims(claims: IdTokenClaims): Principal {
  const groups = groupsOf(claims);
  const role = roleOf(claims, groups);
  // A firm id that is not `firm-<slug>` is no firm: the console shows the no-access screen.
  const firm = FirmId.safeParse(claims["custom:firmId"]);
  return {
    sub: claims.sub,
    groups,
    isJudge: role === "JUDGE" || claims["custom:isJudge"] === "true",
    expiresAt: claims.exp * 1000,
    ...optional("username", claims["cognito:username"]),
    ...optional("email", claims.email),
    ...optional("name", claims.name),
    ...optional("firmId", firm.success ? firm.data : undefined),
    ...optional("role", role),
    ...optional("authTime", claims.auth_time === undefined ? undefined : claims.auth_time * 1000),
  };
}

export function principalFromIdToken(token: string): Principal {
  return principalFromClaims(parseIdTokenClaims(token));
}

/** What the person typed to sign in: the invitation email of a broker or analyst, the username of a judge. */
export function signInNameOf(principal: Principal): string | undefined {
  return principal.email ?? principal.username;
}

/** How the header names the person: never the Cognito `sub`. */
export function displayNameOf(principal: Principal): string | undefined {
  return principal.name ?? principal.email ?? principal.username;
}
