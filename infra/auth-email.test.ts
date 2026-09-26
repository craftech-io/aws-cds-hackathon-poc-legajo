import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConsoleRole } from "@legajo/shared";
import {
  AUTH_LINK_ACTIONS,
  COGNITO_CODE,
  COGNITO_EMAIL_MAX_CHARS,
  COGNITO_SUBJECT_MAX_CHARS,
  COGNITO_USERNAME,
  CONSOLE_GROUPS,
  CONSOLE_GROUP_NAMES,
  CRAFTECH_LOGO_FILE,
  CRAFTECH_URL,
  EMAIL_PALETTE,
  FIRM_ID_ATTRIBUTE,
  FIRM_ID_CLAIM,
  LOGIN_PATH,
  PASSWORD_POLICY,
  PRODUCT_NAME,
  WEB_CLIENT_SETTINGS,
  WEB_ENV_NAMES,
  emailSenderFor,
  fromAddress,
  invitationEmail,
  userPoolSettings,
  verificationEmail,
} from "./auth-email";

// infra/auth.ts only evaluates inside the SST program, and the files of the console and the BFF it
// must agree with import browser or SST modules, so all of them are read as text.
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
/** Every TypeScript source under a directory, as one text. */
const sourcesUnder = (dir: string): string =>
  readdirSync(resolve(process.cwd(), dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => read(`${dir}/${file}`))
    .join("\n");

const APP_DOMAIN = "legajo.demo.craftech.io";
const OPTIONS = { loginUrl: `https://${APP_DOMAIN}/login`, brandUrl: `https://${APP_DOMAIN}/brand` } as const;
const SETTINGS = userPoolSettings(OPTIONS);
const EMAILS = [
  ["invitation", invitationEmail(OPTIONS)],
  ["verification", verificationEmail(OPTIONS)],
] as const;

// Cognito's patterns for a subject and for a message around its `{####}` (API reference of
// VerificationMessageTemplateType and MessageTemplateType).
const COGNITO_SUBJECT = /^[\p{L}\p{M}\p{S}\p{N}\p{P}\s]+$/u;
const COGNITO_MESSAGE = /^[\p{L}\p{M}\p{S}\p{N}\p{P}\s*]*\{####\}[\p{L}\p{M}\p{S}\p{N}\p{P}\s*]*$/u;

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const matches = (html: string, pattern: RegExp): string[] => [...html.matchAll(pattern)].map((match) => match[1] ?? "");
/** Keys of the first `{ … }` block after `opening` in `source`. */
function keysAfter(source: string, opening: string): string[] {
  const start = source.indexOf(opening);
  expect(start, opening).toBeGreaterThanOrEqual(0);
  const body = source.slice(start + opening.length, source.indexOf("}", start + opening.length));
  return matches(body, /^\s*(\w+)\s*[:,]/gm);
}

describe("groups and tenant attribute", () => {
  it("has one group per console role, in the precedence order of @legajo/shared", () => {
    const byPrecedence = [...CONSOLE_GROUP_NAMES].sort((a, b) => CONSOLE_GROUPS[a].precedence - CONSOLE_GROUPS[b].precedence);
    expect(byPrecedence).toEqual(ConsoleRole.options);
    expect(new Set(CONSOLE_GROUP_NAMES.map((group) => CONSOLE_GROUPS[group].precedence)).size).toBe(CONSOLE_GROUP_NAMES.length);
  });

  it("declares custom:firmId as the only custom attribute, a short string", () => {
    expect(SETTINGS.schemas.map((schema) => schema.name)).toEqual([FIRM_ID_ATTRIBUTE]);
    expect(FIRM_ID_CLAIM).toBe("custom:firmId");
    const [schema] = SETTINGS.schemas;
    expect(schema).toMatchObject({ attributeDataType: "String", required: false, stringAttributeConstraints: { minLength: "1", maxLength: "64" } });
  });

  it("lets the web client read the firm and never write it, nor the email", () => {
    expect(WEB_CLIENT_SETTINGS.readAttributes).toContain(FIRM_ID_CLAIM);
    expect(WEB_CLIENT_SETTINGS.writeAttributes).toEqual(["name"]);
    for (const attribute of WEB_CLIENT_SETTINGS.writeAttributes) expect(attribute).not.toMatch(/^custom:|^email/);
  });

  it("uses the claim name the BFF and the console read", () => {
    expect(sourcesUnder("packages/bff/src/auth")).toContain(`"${FIRM_ID_CLAIM}"`);
    expect(sourcesUnder("packages/web/src/lib")).toContain(`"${FIRM_ID_CLAIM}"`);
  });
});

describe("sign-up, recovery and passwords", () => {
  it("creates users only through AdminCreateUser and recovers them only by verified email", () => {
    expect(SETTINGS.adminCreateUserConfig.allowAdminCreateUserOnly).toBe(true);
    expect(SETTINGS.accountRecoverySetting.recoveryMechanisms).toEqual([{ name: "verified_email", priority: 1 }]);
  });

  it("runs on the feature plan of the V2_0 pre token trigger and can be removed", () => {
    expect(SETTINGS.userPoolTier).toBe("ESSENTIALS");
    expect(SETTINGS.deletionProtection).toBe("INACTIVE");
  });

  it("asks for the password the console checks before sending", () => {
    const minLength = /PASSWORD_MIN_LENGTH = (\d+);/.exec(read("packages/web/src/lib/auth/credentials.ts"))?.[1];
    expect(Number(minLength)).toBe(PASSWORD_POLICY.minimumLength);
    expect(SETTINGS.passwordPolicy).toEqual({ ...PASSWORD_POLICY });
    expect(PASSWORD_POLICY).toMatchObject({ requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSymbols: true });
  });

  it("templates the invitation and the code message, SMS-free", () => {
    expect(SETTINGS.adminCreateUserConfig.inviteMessageTemplate).toEqual({ emailSubject: EMAILS[0][1].subject, emailMessage: EMAILS[0][1].message });
    expect(SETTINGS.verificationMessageTemplate).toEqual({
      defaultEmailOption: "CONFIRM_WITH_CODE",
      emailSubject: EMAILS[1][1].subject,
      emailMessage: EMAILS[1][1].message,
    });
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
  });

  it("issues 15-minute id and access tokens and a 12-hour refresh token, inside Cognito's bounds", () => {
    const { accessTokenValidity, idTokenValidity, refreshTokenValidity, tokenValidityUnits } = WEB_CLIENT_SETTINGS;
    expect({ accessTokenValidity, idTokenValidity, refreshTokenValidity }).toEqual({ accessTokenValidity: 15, idTokenValidity: 15, refreshTokenValidity: 12 });
    expect(tokenValidityUnits).toEqual({ accessToken: "minutes", idToken: "minutes", refreshToken: "hours" });
    // Access and id tokens: 5 minutes to 1 day. Refresh token: 1 hour to 10 years.
    for (const minutes of [accessTokenValidity, idTokenValidity]) expect(minutes).toBeGreaterThanOrEqual(5);
    expect(refreshTokenValidity).toBeGreaterThanOrEqual(1);
  });

  it("revokes tokens on sign-out and never tells whether a user exists", () => {
    expect(WEB_CLIENT_SETTINGS.enableTokenRevocation).toBe(true);
    expect(WEB_CLIENT_SETTINGS.preventUserExistenceErrors).toBe("ENABLED");
  });
});

describe("sender of the console emails", () => {
  const verified = { domain: APP_DOMAIN, arn: `arn:aws:ses:us-east-1:111111111111:identity/${APP_DOMAIN}`, verified: true };

  it("sends through SES from no-reply of the app domain once the identity is verified", () => {
    expect(emailSenderFor(verified, APP_DOMAIN)).toEqual({
      configuration: { emailSendingAccount: "DEVELOPER", sourceArn: verified.arn, fromEmailAddress: `${PRODUCT_NAME} <no-reply@${APP_DOMAIN}>` },
    });
  });

  it("keeps Cognito's sender, with a deploy warning, while the identity is missing or unverified", () => {
    for (const identity of [undefined, { ...verified, verified: false }]) {
      const choice = emailSenderFor(identity, APP_DOMAIN);
      expect(choice.configuration).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
      expect(choice.warning).toContain(APP_DOMAIN);
    }
    expect(emailSenderFor(undefined, APP_DOMAIN).warning).toContain("infra/messaging-email.ts");
  });

  it("fails the deploy when the identity belongs to another domain", () => {
    expect(() => emailSenderFor({ ...verified, domain: `sim.${APP_DOMAIN}` }, APP_DOMAIN)).toThrow(/another|sim\./);
  });

  it("writes an ASCII From header and refuses header injection", () => {
    expect(fromAddress(PRODUCT_NAME, `no-reply@${APP_DOMAIN}`)).toMatch(/^[\x20-\x7e]+$/);
    for (const name of ["Legajo\r\nBcc: x", "Legajo, listo", " Legajo", "Légajo"]) expect(() => fromAddress(name, `no-reply@${APP_DOMAIN}`)).toThrow();
    for (const address of [`No-Reply@${APP_DOMAIN}`, "no-reply", `no-reply@${APP_DOMAIN}\r\n`]) expect(() => fromAddress(PRODUCT_NAME, address)).toThrow();
  });
});

describe("emails", () => {
  for (const [name, email] of EMAILS) {
    describe(name, () => {
      it("stays inside Cognito's limits and character classes", () => {
        expect(email.message.length).toBeLessThanOrEqual(COGNITO_EMAIL_MAX_CHARS);
        expect(email.subject.length).toBeLessThanOrEqual(COGNITO_SUBJECT_MAX_CHARS);
        expect(email.subject).toMatch(COGNITO_SUBJECT);
        expect(email.message).toMatch(COGNITO_MESSAGE);
      });

      it("carries the code placeholder exactly once", () => {
        expect(count(email.message, COGNITO_CODE)).toBe(1);
      });

      it("links only to the console login and to craftech.io", () => {
        const links = matches(email.message, /href="([^"]+)"/g);
        expect(links).toContain(OPTIONS.loginUrl);
        expect(new Set(links)).toEqual(new Set([OPTIONS.loginUrl, CRAFTECH_URL]));
      });

      it("shows only Craftech's PNG logo, from the app domain, and the product as a text wordmark", () => {
        expect(matches(email.message, /<img[^>]*\ssrc="([^"]+)"/g)).toEqual([`${OPTIONS.brandUrl}/${CRAFTECH_LOGO_FILE}`]);
        expect(existsSync(resolve(process.cwd(), "packages/web/public/brand", CRAFTECH_LOGO_FILE))).toBe(true);
        expect(email.message).toMatch(/Legajo <span[^>]*>listo<\/span>/);
        expect(email.message).toContain(PRODUCT_NAME);
        expect(email.message).toContain("Powered by");
        expect(email.message).toContain('alt="Craftech"');
      });

      it("says it is a demo with fictitious data", () => {
        expect(email.message).toMatch(/datos sintéticos/);
        expect(email.message).toMatch(/ficticios/);
      });

      it("inlines every style in the console palette: no stylesheet, script or class", () => {
        expect(email.message).not.toMatch(/<style|<script|<link|\sclass=/i);
        expect(email.message).toContain('<html lang="es-AR">');
        const colors = new Set<string>(Object.values(EMAIL_PALETTE));
        for (const color of email.message.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) expect(colors.has(color), color).toBe(true);
      });
    });
  }

  it("uses exactly the colours of the console theme", () => {
    const css = read("packages/web/src/index.css");
    for (const [token, value] of Object.entries(EMAIL_PALETTE)) {
      expect(new RegExp(`--color-${token}:\\s*([^;]+);`).exec(css)?.[1]?.trim().toLowerCase(), token).toBe(value);
    }
  });

  it("the invitation gives the username and the temporary password and presents TOTP as optional", () => {
    const { message, subject } = invitationEmail(OPTIONS);
    expect(count(message, COGNITO_USERNAME)).toBe(1);
    expect(subject).toContain(PRODUCT_NAME);
    expect(message).toContain("Contraseña temporal");
    expect(message).toContain(`vence en ${PASSWORD_POLICY.temporaryPasswordValidityDays} días`);
    expect(message).toContain(`al menos ${PASSWORD_POLICY.minimumLength} caracteres`);
    expect(message).toMatch(/TOTP[^<]*\. Es opcional/);
  });

  it("the code message has no username placeholder", () => {
    expect(verificationEmail(OPTIONS).message).not.toContain(COGNITO_USERNAME);
  });

  it("refuses links that are not plain absolute https URLs", () => {
    for (const loginUrl of [`http://${APP_DOMAIN}/login`, `https://${APP_DOMAIN}/login" onclick="x`, "/login"]) {
      expect(() => invitationEmail({ ...OPTIONS, loginUrl })).toThrow();
      expect(() => verificationEmail({ ...OPTIONS, loginUrl })).toThrow();
    }
  });
});

describe("infra/auth.ts wiring", () => {
  const auth = read("infra/auth.ts").replace(/^\s*\/\/.*$/gm, "");

  it("builds one pool: email alias, optional TOTP, V2_0 pre token trigger, no hosted UI", () => {
    expect(count(auth, "new sst.aws.CognitoUserPool(")).toBe(1);
    expect(auth).toContain('aliases: ["email"]');
    expect(auth).not.toMatch(/\busernames:/);
    expect(auth).toContain('mfa: "optional"');
    expect(auth).toContain("softwareToken: true");
    expect(auth).toContain('preTokenGenerationVersion: "v2"');
    expect(auth).toContain('"packages/bff/src/auth-triggers/pre-token.handler"');
    expect(auth).toMatch(/\.\.\.userPoolSettings\(/);
    expect(auth).toContain("client: WEB_CLIENT_SETTINGS");
    const poolArgs = auth.slice(auth.indexOf("new sst.aws.CognitoUserPool("), auth.indexOf("\n});", auth.indexOf("new sst.aws.CognitoUserPool(")));
    expect(poolArgs).not.toMatch(/\bdomain:/);
  });

  it("links what packages/bff/src/auth/config.ts reads and grants only AdminGetUser on the pool", () => {
    const linked = keysAfter(auth, 'new sst.Linkable("Auth", {\n  properties: {');
    const bffKeys = keysAfter(read("packages/bff/src/auth/config.ts"), "const AuthResource = z.object({");
    expect(bffKeys.length).toBeGreaterThan(0);
    expect([...linked].sort()).toEqual([...bffKeys].sort());
    expect(AUTH_LINK_ACTIONS).toEqual(["cognito-idp:AdminGetUser"]);
    expect(auth).toContain("sst.aws.permission({ actions: [...AUTH_LINK_ACTIONS], resources: [userPool.arn] })");
  });

  it("hands the console the build-time variables and the login path it reads", () => {
    const env = read("packages/web/src/lib/env.ts");
    for (const name of Object.values(WEB_ENV_NAMES)) expect(env).toContain(`env.${name}`);
    expect(/export const LOGIN_PATH = "([^"]+)";/.exec(read("packages/web/src/routes.ts"))?.[1]).toBe(LOGIN_PATH);
  });
});
