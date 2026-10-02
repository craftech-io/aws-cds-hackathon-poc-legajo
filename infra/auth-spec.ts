// Pure half of the console's Cognito user pool (infra/auth.ts, docs/architecture.md §10, ADR-0015 §1):
// the settings of the pool and its web client, its three triggers and the guard that keeps the
// public signup closed unless `PreSignUp` checks the signup ticket. No SST or Pulumi dependency, so
// infra/auth-spec.test.ts checks every value without an AWS account. Visible texts (group
// descriptions, sender) live in infra/auth-email.ts.
//
// Who gets in:
//   - internal staff (BROKER, ANALYST) and reserved guests (`guest-01..NN`, `guest-test`): only the
//     operator, with AdminCreateUser through `npm run console:invite`, which sets group and
//     `custom:firmId`. `PreSignUp_AdminCreateUser` passes without a ticket.
//   - public guests: `/signup`. The browser never calls SignUp: `SignupDispatch` does, with a ticket
//     `PreSignUp` verifies by HMAC (120 s), so a SignUp straight against the public client creates no
//     user and sends no code. `AllowAdminCreateUserOnly` is `false` ONLY because that trigger is wired
//     (`adminCreateUserOnly`); without it the pool stays closed.
//
// The web client may write `email` and `locale` because SignupDispatch signs up through it (SignUp
// checks the client's write attributes); `custom:firmId` stays read-only. A GUEST cannot change any
// attribute: `AuthPreToken` takes `aws.cognito.signin.user.admin` out of its access token. An email
// change of internal staff waits for the new address to be verified (`userAttributeUpdateSettings`),
// since the email is the sign-in alias.

import { PASSWORD_POLICY } from "../packages/shared/src/password-policy";
import type { LambdaName } from "./iam-capabilities";

// ---- Attributes and contracts with packages/bff and packages/web ---------------------------------

/** The tenant key: set by the invitation, readable by the web client, never writable by it. */
export const FIRM_ID_ATTRIBUTE = "firmId";
export const FIRM_ID_CLAIM = `custom:${FIRM_ID_ATTRIBUTE}`;

/** Standard attribute with the language of the account emails; SignupDispatch sets it on SignUp. */
export const LOCALE_ATTRIBUTE = "locale";
export const ACCOUNT_EMAIL_LOCALES = ["es", "en"] as const;

/** The only IAM action the `Auth` link grants: the BFF reads whether a user has TOTP on. */
export const AUTH_LINK_ACTIONS = ["cognito-idp:AdminGetUser"] as const;

/** Build-time variables of the console, as packages/web/src/lib/env.ts reads them. */
export const WEB_ENV_NAMES = { userPoolId: "VITE_COGNITO_USER_POOL_ID", clientId: "VITE_COGNITO_CLIENT_ID" } as const;

/** Sign-in route of the console (packages/web/src/routes.ts `LOGIN_PATH`). */
export const LOGIN_PATH = "/login";

/** A temporary password of AdminCreateUser lasts this long (a pool setting, not a password rule). */
export const TEMPORARY_PASSWORD_VALIDITY_DAYS = 7;

// ---- Triggers ------------------------------------------------------------------------------------

export type TriggerKey = "preSignUp" | "customMessage" | "preTokenGeneration";

export interface TriggerSpec {
  /** The Lambda of docs/architecture.md §14 (infra/iam-capabilities.ts). */
  readonly fn: Extract<LambdaName, "AuthPreSignUp" | "AuthCustomMessage" | "AuthPreToken">;
  /** The file belongs to WP-50 (packages/bff/src/auth-triggers/). */
  readonly handler: string;
  readonly description: string;
  /** Cognito waits 5 s at most; no reserved concurrency (a throttled trigger would fail the sign-in). */
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
}

export const COGNITO_TRIGGERS: Readonly<Record<TriggerKey, TriggerSpec>> = {
  preSignUp: {
    fn: "AuthPreSignUp",
    handler: "packages/bff/src/auth-triggers/pre-signup.handler",
    description: "Cognito pre sign-up: refuses every SignUp without a valid signup ticket; AdminCreateUser passes.",
    timeoutSeconds: 5,
    memoryMb: 256,
  },
  customMessage: {
    fn: "AuthCustomMessage",
    handler: "packages/bff/src/auth-triggers/custom-message.handler",
    description: "Cognito custom message: neutral es/en account emails, per-recipient quotas, bounce state and breaker.",
    timeoutSeconds: 5,
    memoryMb: 256,
  },
  preTokenGeneration: {
    fn: "AuthPreToken",
    handler: "packages/bff/src/auth-triggers/pre-token.handler",
    description: "Cognito pre token generation (V2_0): firmId, role, isGuest and worldLease from Firms/BROKER#; no admin scope for guests.",
    timeoutSeconds: 5,
    memoryMb: 256,
  },
};

export const TRIGGER_KEYS = Object.keys(COGNITO_TRIGGERS) as TriggerKey[];

/** V2_0 also shapes the access token (the guest's scope); it needs the ESSENTIALS feature plan. */
export const PRE_TOKEN_GENERATION_VERSION = "v2";

/**
 * Whether only AdminCreateUser may create users. The public signup opens (`false`) only when the
 * `PreSignUp` trigger that checks the signup ticket is wired; any other set of triggers keeps it closed.
 */
export function adminCreateUserOnly(triggers: readonly TriggerKey[]): boolean {
  return !triggers.includes("preSignUp");
}

/** Fails the deploy if the pool would accept a SignUp that no `PreSignUp` checks. */
export function assertSignupGuarded(allowAdminCreateUserOnly: boolean, triggers: readonly TriggerKey[]): void {
  if (!allowAdminCreateUserOnly && !triggers.includes("preSignUp")) {
    throw new Error("AllowAdminCreateUserOnly is false without the PreSignUp trigger: anyone could sign up straight against the public client (ADR-0015 §1).");
  }
}

// ---- Web client ----------------------------------------------------------------------------------

type TokenUnit = "minutes" | "hours";

export interface WebClientSettings {
  generateSecret: boolean;
  allowedOauthFlowsUserPoolClient: boolean;
  allowedOauthFlows: string[];
  allowedOauthScopes: string[];
  callbackUrls: string[];
  logoutUrls: string[];
  supportedIdentityProviders: string[];
  explicitAuthFlows: string[];
  preventUserExistenceErrors: "ENABLED";
  enableTokenRevocation: boolean;
  accessTokenValidity: number;
  idTokenValidity: number;
  refreshTokenValidity: number;
  tokenValidityUnits: { accessToken: TokenUnit; idToken: TokenUnit; refreshToken: TokenUnit };
  readAttributes: string[];
  writeAttributes: string[];
}

// Public client of the browser and of SignupDispatch: SRP and refresh only, no secret, no OAuth, no
// hosted UI (the placeholder callback URL SST puts on a client is cleared). Tokens live 15 minutes
// because the BFF verifies them offline; the console refreshes silently with the 12-hour refresh
// token. Revocation also puts `origin_jti` on the tokens (one session per guest world).
export const WEB_CLIENT_SETTINGS: WebClientSettings = {
  generateSecret: false,
  allowedOauthFlowsUserPoolClient: false,
  allowedOauthFlows: [],
  allowedOauthScopes: [],
  callbackUrls: [],
  logoutUrls: [],
  supportedIdentityProviders: ["COGNITO"],
  explicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  preventUserExistenceErrors: "ENABLED",
  enableTokenRevocation: true,
  accessTokenValidity: 15,
  idTokenValidity: 15,
  refreshTokenValidity: 12,
  tokenValidityUnits: { accessToken: "minutes", idToken: "minutes", refreshToken: "hours" },
  readAttributes: ["email", "email_verified", LOCALE_ATTRIBUTE, "name", FIRM_ID_CLAIM],
  writeAttributes: ["email", LOCALE_ATTRIBUTE, "name"],
};

// ---- Pool ----------------------------------------------------------------------------------------

export interface PoolPasswordPolicy {
  minimumLength: number;
  requireLowercase: boolean;
  requireUppercase: boolean;
  requireNumbers: boolean;
  requireSymbols: boolean;
  temporaryPasswordValidityDays: number;
}

export interface UserPoolSettings {
  userPoolTier: "ESSENTIALS";
  deletionProtection: "INACTIVE";
  adminCreateUserConfig: { allowAdminCreateUserOnly: boolean };
  verificationMessageTemplate: { defaultEmailOption: "CONFIRM_WITH_CODE" };
  schemas: Array<{
    name: string;
    attributeDataType: "String";
    mutable: boolean;
    required: boolean;
    stringAttributeConstraints: { minLength: string; maxLength: string };
  }>;
  accountRecoverySetting: { recoveryMechanisms: Array<{ name: "verified_email"; priority: number }> };
  passwordPolicy: PoolPasswordPolicy;
  userAttributeUpdateSettings: { attributesRequireVerificationBeforeUpdates: string[] };
}

/** The pool's password policy, from the single source packages/shared/src/password-policy.ts. */
export function poolPasswordPolicy(): PoolPasswordPolicy {
  return {
    minimumLength: PASSWORD_POLICY.minLength,
    requireLowercase: PASSWORD_POLICY.requireLowercase,
    requireUppercase: PASSWORD_POLICY.requireUppercase,
    requireNumbers: PASSWORD_POLICY.requireNumbers,
    requireSymbols: PASSWORD_POLICY.requireSymbols,
    temporaryPasswordValidityDays: TEMPORARY_PASSWORD_VALIDITY_DAYS,
  };
}

/**
 * What infra/auth.ts lays over SST's pool defaults, for the triggers it wires. ESSENTIALS runs the
 * pre token trigger V2_0 (free up to 10,000 monthly active users, nothing billed by the hour). Codes,
 * never links; recovery only through the verified email. The account emails come from
 * `AuthCustomMessage`, so the pool carries no message template of its own.
 */
export function userPoolSettings(triggers: readonly TriggerKey[]): UserPoolSettings {
  const allowAdminCreateUserOnly = adminCreateUserOnly(triggers);
  assertSignupGuarded(allowAdminCreateUserOnly, triggers);
  return {
    userPoolTier: "ESSENTIALS",
    // Removal is `remove` in every stage (CLAUDE.md).
    deletionProtection: "INACTIVE",
    adminCreateUserConfig: { allowAdminCreateUserOnly },
    verificationMessageTemplate: { defaultEmailOption: "CONFIRM_WITH_CODE" },
    schemas: [
      {
        name: FIRM_ID_ATTRIBUTE,
        attributeDataType: "String",
        mutable: true,
        required: false,
        stringAttributeConstraints: { minLength: "1", maxLength: "64" },
      },
    ],
    accountRecoverySetting: { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] },
    passwordPolicy: poolPasswordPolicy(),
    userAttributeUpdateSettings: { attributesRequireVerificationBeforeUpdates: ["email"] },
  };
}
