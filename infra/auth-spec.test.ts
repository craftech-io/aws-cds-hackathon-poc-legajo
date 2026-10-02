import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PASSWORD_POLICY } from "../packages/shared/src/password-policy";
import {
  ACCOUNT_EMAIL_LOCALES,
  AUTH_LINK_ACTIONS,
  COGNITO_TRIGGERS,
  FIRM_ID_ATTRIBUTE,
  FIRM_ID_CLAIM,
  LOCALE_ATTRIBUTE,
  LOGIN_PATH,
  PRE_TOKEN_GENERATION_VERSION,
  TRIGGER_KEYS,
  WEB_CLIENT_SETTINGS,
  WEB_ENV_NAMES,
  adminCreateUserOnly,
  assertSignupGuarded,
  userPoolSettings,
  type TriggerKey,
} from "./auth-spec";
import { LAMBDA_CAPABILITIES, expectedTables } from "./iam-capabilities";

// infra/auth.ts only evaluates inside the SST program, and the console and BFF files it must agree with
// import browser or SST modules, so all of them are read as text.
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** Every TypeScript source under a directory, as one text. */
const sourcesUnder = (dir: string): string =>
  readdirSync(resolve(process.cwd(), dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => read(`${dir}/${file}`))
    .join("\n");
const matches = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((match) => match[1] ?? "");
/** Keys of the first `{ … }` block after `opening` in `source`. */
function keysAfter(source: string, opening: string): string[] {
  const start = source.indexOf(opening);
  expect(start, opening).toBeGreaterThanOrEqual(0);
  return matches(source.slice(start + opening.length, source.indexOf("}", start + opening.length)), /^\s*(\w+)\s*[:,]/gm);
}

const auth = stripComments(read("infra/auth.ts"));
const architecture = read("docs/architecture.md");
const SETTINGS = userPoolSettings(TRIGGER_KEYS);

describe("public signup guard (ADR-0015 §1)", () => {
  it("opens SignUp only with the PreSignUp trigger wired, and fails the deploy otherwise", () => {
    expect(TRIGGER_KEYS.sort()).toEqual(["customMessage", "preSignUp", "preTokenGeneration"]);
    expect(SETTINGS.adminCreateUserConfig).toEqual({ allowAdminCreateUserOnly: false });
    const withoutPreSignUp: TriggerKey[] = ["customMessage", "preTokenGeneration"];
    expect(adminCreateUserOnly(withoutPreSignUp)).toBe(true);
    expect(userPoolSettings(withoutPreSignUp).adminCreateUserConfig.allowAdminCreateUserOnly).toBe(true);
    expect(() => assertSignupGuarded(false, withoutPreSignUp)).toThrow(/PreSignUp/);
    expect(() => assertSignupGuarded(false, TRIGGER_KEYS)).not.toThrow();
    expect(() => assertSignupGuarded(true, [])).not.toThrow();
  });

  it("feeds the same trigger list to the pool's triggers and to its settings in infra/auth.ts", () => {
    expect(auth).toContain("...userPoolSettings(TRIGGER_KEYS),");
    const triggers = keysAfter(auth, "triggers: {");
    expect(triggers.sort()).toEqual(["customMessage", "preSignUp", "preTokenGeneration", "preTokenGenerationVersion"]);
    for (const key of TRIGGER_KEYS) expect(auth).toContain(`${key}: triggerFunctions.${key}.arn,`);
    expect(auth).toContain("preTokenGenerationVersion: PRE_TOKEN_GENERATION_VERSION,");
    expect(PRE_TOKEN_GENERATION_VERSION).toBe("v2");
    expect(SETTINGS.userPoolTier).toBe("ESSENTIALS");
  });

  it("never tells whether an email has an account, from any API of the web client", () => {
    expect(WEB_CLIENT_SETTINGS.preventUserExistenceErrors).toBe("ENABLED");
    expect(architecture).toContain("`preventUserExistenceErrors`");
  });
});

describe("triggers", () => {
  it("are the three trigger Lambdas of docs/architecture.md §14, with handlers owned by WP-50", () => {
    const plan = read("docs/build-plan.md");
    const wp50 = plan.slice(plan.indexOf("**WP-50 · "), plan.indexOf("**WP-51 · "));
    expect(wp50).toContain("`packages/bff/src/auth-triggers/**`");
    for (const key of TRIGGER_KEYS) {
      const spec = COGNITO_TRIGGERS[key];
      expect(LAMBDA_CAPABILITIES, key).toHaveProperty(spec.fn);
      expect(spec.handler, key).toMatch(/^packages\/bff\/src\/auth-triggers\/[a-z-]+\.handler$/);
      // Cognito waits 5 s for a trigger; none gets reserved concurrency (docs/architecture.md §12).
      expect(spec.timeoutSeconds, key).toBe(5);
      expect(architecture).toContain(`\`${spec.fn}\``);
    }
    expect(Object.values(COGNITO_TRIGGERS).map((spec) => spec.fn).sort()).toEqual(["AuthCustomMessage", "AuthPreSignUp", "AuthPreToken"]);
    expect(auth).not.toMatch(/concurrency/);
  });

  it("link exactly what their §14 rows say: never Leads", () => {
    expect(auth).toContain("preSignUp: () => links([SessionTokenKey]),");
    // Runtime only by name (`RuntimeKeys`) plus its key-fenced statement: never the whole table.
    expect(auth).toContain("customMessage: () => links([SessionTokenKey], tableLinks([RUNTIME_KEYS_LINK])),");
    expect(auth).toContain('runtimeKeysStatement("AuthCustomMessage", module.Runtime.arn)');
    expect(auth).toContain("permissions: TRIGGER_PERMISSIONS[key]?.() ?? [],");
    expect(auth).not.toMatch(/tableLinks\(\["Runtime"\]\)/);
    expect(auth).toContain('preTokenGeneration: () => tableLinks(["Firms"]),');
    expect(auth).not.toMatch(/Leads|leadsTable/);
    expect(Object.keys(expectedTables("AuthPreSignUp"))).toEqual([]);
    expect(Object.keys(expectedTables("AuthCustomMessage"))).toEqual(["Runtime"]);
    expect(Object.keys(expectedTables("AuthPreToken"))).toEqual(["Firms"]);
  });
});

describe("attributes and tenancy", () => {
  it("declares custom:firmId as the only custom attribute, a short string", () => {
    expect(SETTINGS.schemas.map((schema) => schema.name)).toEqual([FIRM_ID_ATTRIBUTE]);
    expect(FIRM_ID_CLAIM).toBe("custom:firmId");
    expect(SETTINGS.schemas[0]).toMatchObject({ attributeDataType: "String", required: false, stringAttributeConstraints: { minLength: "1", maxLength: "64" } });
  });

  it("signs in with the email as an alias and keeps the language of the account emails in locale", () => {
    expect(auth).toContain('aliases: ["email"]');
    expect(auth).not.toMatch(/\busernames:/);
    expect(LOCALE_ATTRIBUTE).toBe("locale");
    expect([...ACCOUNT_EMAIL_LOCALES]).toEqual(["es", "en"]);
    expect(architecture).toContain("`locale` (`es` \\| `en`, idioma de los emails de cuenta)");
  });

  it("lets the signup write email and locale, never the firm, and waits for a new email to be verified", () => {
    expect(WEB_CLIENT_SETTINGS.writeAttributes).toEqual(["email", "locale", "name"]);
    expect(WEB_CLIENT_SETTINGS.writeAttributes).not.toContain(FIRM_ID_CLAIM);
    for (const attribute of WEB_CLIENT_SETTINGS.writeAttributes) expect(attribute).not.toMatch(/^custom:/);
    expect(WEB_CLIENT_SETTINGS.readAttributes).toEqual(expect.arrayContaining([FIRM_ID_CLAIM, "locale", "email"]));
    expect(SETTINGS.userAttributeUpdateSettings).toEqual({ attributesRequireVerificationBeforeUpdates: ["email"] });
  });

  it("uses the claim name the BFF and the console read", () => {
    expect(sourcesUnder("packages/bff/src/auth")).toContain(`"${FIRM_ID_CLAIM}"`);
    expect(sourcesUnder("packages/web/src/lib")).toContain(`"${FIRM_ID_CLAIM}"`);
  });
});

describe("passwords, codes and recovery", () => {
  it("asks for the password of the single source packages/shared/src/password-policy.ts", () => {
    expect(SETTINGS.passwordPolicy).toEqual({
      minimumLength: PASSWORD_POLICY.minLength,
      requireLowercase: PASSWORD_POLICY.requireLowercase,
      requireUppercase: PASSWORD_POLICY.requireUppercase,
      requireNumbers: PASSWORD_POLICY.requireNumbers,
      requireSymbols: PASSWORD_POLICY.requireSymbols,
      temporaryPasswordValidityDays: 7,
    });
    expect(PASSWORD_POLICY).toMatchObject({ requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSymbols: true });
    expect(read("infra/auth-spec.ts")).toContain('from "../packages/shared/src/password-policy"');
  });

  it("confirms with codes, recovers only by the verified email, and carries no message template of its own", () => {
    expect(SETTINGS.verificationMessageTemplate).toEqual({ defaultEmailOption: "CONFIRM_WITH_CODE" });
    expect(SETTINGS.accountRecoverySetting.recoveryMechanisms).toEqual([{ name: "verified_email", priority: 1 }]);
    expect(SETTINGS.deletionProtection).toBe("INACTIVE");
  });
});

describe("web client", () => {
  it("speaks only SRP and refresh, with no secret, no OAuth and no hosted UI", () => {
    expect(WEB_CLIENT_SETTINGS.explicitAuthFlows).toEqual(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]);
    expect(WEB_CLIENT_SETTINGS.generateSecret).toBe(false);
    expect(WEB_CLIENT_SETTINGS.allowedOauthFlowsUserPoolClient).toBe(false);
    for (const list of [WEB_CLIENT_SETTINGS.allowedOauthFlows, WEB_CLIENT_SETTINGS.allowedOauthScopes, WEB_CLIENT_SETTINGS.callbackUrls, WEB_CLIENT_SETTINGS.logoutUrls]) {
      expect(list).toEqual([]);
    }
    expect(WEB_CLIENT_SETTINGS.supportedIdentityProviders).toEqual(["COGNITO"]);
    const poolArgs = auth.slice(auth.indexOf("new sst.aws.CognitoUserPool("), auth.indexOf("\n});", auth.indexOf("new sst.aws.CognitoUserPool(")));
    expect(poolArgs).not.toMatch(/\bdomain:/);
  });

  it("issues 15-minute id and access tokens and a 12-hour refresh token, and revokes on sign-out", () => {
    const { accessTokenValidity, idTokenValidity, refreshTokenValidity, tokenValidityUnits } = WEB_CLIENT_SETTINGS;
    expect({ accessTokenValidity, idTokenValidity, refreshTokenValidity }).toEqual({ accessTokenValidity: 15, idTokenValidity: 15, refreshTokenValidity: 12 });
    expect(tokenValidityUnits).toEqual({ accessToken: "minutes", idToken: "minutes", refreshToken: "hours" });
    expect(WEB_CLIENT_SETTINGS.enableTokenRevocation).toBe(true);
  });

  it("offers TOTP as optional and only by software token, never SMS", () => {
    expect(auth).toContain('mfa: "optional"');
    expect(auth).toContain("softwareToken: true");
    expect(auth).not.toMatch(/\bsms\b/i);
  });
});

describe("links and build-time variables", () => {
  it("links what packages/bff/src/auth/config.ts reads and grants only AdminGetUser on the pool", () => {
    const linked = keysAfter(auth, 'new sst.Linkable("Auth", {\n  properties: {');
    const bffKeys = keysAfter(read("packages/bff/src/auth/config.ts"), "const AuthResource = z.object({");
    expect(bffKeys.length).toBeGreaterThan(0);
    expect([...linked].sort()).toEqual([...bffKeys].sort());
    expect(AUTH_LINK_ACTIONS).toEqual(["cognito-idp:AdminGetUser"]);
    expect(auth).toContain("sst.aws.permission({ actions: [...AUTH_LINK_ACTIONS], resources: [userPool.arn] })");
  });

  it("hands the console the build-time variables and the login path it reads, and nothing about the signup", () => {
    const env = read("packages/web/src/lib/env.ts");
    for (const name of Object.values(WEB_ENV_NAMES)) expect(env).toContain(`env.${name}`);
    expect(/export const LOGIN_PATH = "([^"]+)";/.exec(read("packages/web/src/routes.ts"))?.[1]).toBe(LOGIN_PATH);
    // One signup flow, no modes (ADR-0015 §1.4): no build variable decides the CTA, robots or WAF.
    expect(Object.values(WEB_ENV_NAMES).sort()).toEqual(["VITE_COGNITO_CLIENT_ID", "VITE_COGNITO_USER_POOL_ID"]);
  });
});
