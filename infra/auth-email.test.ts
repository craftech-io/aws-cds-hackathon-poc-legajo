import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConsoleRole } from "@legajo/shared";
import { findNeutralHits } from "../scripts/lint/neutral-words";
import { CONSOLE_GROUPS, CONSOLE_GROUP_NAMES, NO_REPLY_LOCAL_PART, PRODUCT_NAME, emailSenderFor, fromAddress } from "./auth-email";
import { configurationSetName } from "./messaging-email-spec";

// infra/auth.ts only evaluates inside the SST program, so its wiring is read as text.
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const APP_DOMAIN = "legajo.demo.craftech.io";
const EMAIL_SET = configurationSetName("aws-cds-hackathon-poc-legajo", "poc", "email");

describe("groups", () => {
  it("has one group per console role, in the precedence order of @legajo/shared", () => {
    const byPrecedence = [...CONSOLE_GROUP_NAMES].sort((a, b) => CONSOLE_GROUPS[a].precedence - CONSOLE_GROUPS[b].precedence);
    expect(byPrecedence).toEqual(ConsoleRole.options);
    expect(new Set(CONSOLE_GROUP_NAMES.map((group) => CONSOLE_GROUPS[group].precedence)).size).toBe(CONSOLE_GROUP_NAMES.length);
  });

  it("names the guest group GUEST, precedence 20, with a neutral description and no TOTP (ADR-0014 §8)", () => {
    expect(CONSOLE_GROUPS.GUEST).toEqual({ precedence: 20, totp: "off", description: "Guest: broker permissions inside its own demo firm, no TOTP" });
    expect(CONSOLE_GROUPS.BROKER.totp).toBe("optional");
    expect(CONSOLE_GROUPS.ANALYST.totp).toBe("optional");
    for (const group of CONSOLE_GROUP_NAMES) expect(findNeutralHits(CONSOLE_GROUPS[group].description), group).toEqual([]);
  });
});

describe("sender of the account emails", () => {
  const verified = { domain: APP_DOMAIN, arn: `arn:aws:ses:us-east-1:111111111111:identity/${APP_DOMAIN}`, verified: true };

  it("sends through SES from no-reply of the app domain and the email configuration set once the identity is verified", () => {
    expect(EMAIL_SET).toBe("aws-cds-hackathon-poc-legajo-email-poc");
    expect(emailSenderFor(verified, APP_DOMAIN, EMAIL_SET)).toEqual({
      configuration: {
        emailSendingAccount: "DEVELOPER",
        sourceArn: verified.arn,
        fromEmailAddress: `${PRODUCT_NAME} <${NO_REPLY_LOCAL_PART}@${APP_DOMAIN}>`,
        configurationSet: EMAIL_SET,
      },
    });
    expect(read("docs/adr/0015-alta-publica-de-invitados-y-leads.md")).toContain("Remitente `Legajo listo <no-reply@legajo.demo.craftech.io>`");
  });

  it("keeps Cognito's sender, with a deploy warning, while the identity is missing or unverified", () => {
    for (const identity of [undefined, { ...verified, verified: false }]) {
      const choice = emailSenderFor(identity, APP_DOMAIN, EMAIL_SET);
      expect(choice.configuration).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
      expect(choice.warning).toContain(APP_DOMAIN);
    }
    expect(emailSenderFor(undefined, APP_DOMAIN, EMAIL_SET).warning).toContain("infra/messaging-email.ts");
  });

  it("fails the deploy when the identity belongs to another domain or the set is not the email set", () => {
    expect(() => emailSenderFor({ ...verified, domain: `sim.${APP_DOMAIN}` }, APP_DOMAIN, EMAIL_SET)).toThrow(/sim\./);
    expect(() => emailSenderFor(verified, APP_DOMAIN, configurationSetName("aws-cds-hackathon-poc-legajo", "poc", "sim"))).toThrow(/email configuration set/);
  });

  it("writes an ASCII From header and refuses header injection", () => {
    expect(fromAddress(PRODUCT_NAME, `no-reply@${APP_DOMAIN}`)).toMatch(/^[\x20-\x7e]+$/);
    for (const name of ["Legajo\r\nBcc: x", "Legajo, listo", " Legajo", "Légajo"]) expect(() => fromAddress(name, `no-reply@${APP_DOMAIN}`)).toThrow();
    for (const address of [`No-Reply@${APP_DOMAIN}`, "no-reply", `no-reply@${APP_DOMAIN}\r\n`]) expect(() => fromAddress(PRODUCT_NAME, address)).toThrow();
  });
});

describe("account email templates", () => {
  it("live in packages/bff/src/auth-triggers/messages/ (WP-50), never in infra/ (ADR-0015 §7)", () => {
    for (const file of ["infra/auth-email.ts", "infra/auth-spec.ts", "infra/auth.ts"]) {
      const source = stripComments(read(file));
      expect(source, file).not.toContain("{####}");
      expect(source, file).not.toContain("{username}");
      expect(source, file).not.toMatch(/<html|<table|inviteMessageTemplate|emailMessage|emailSubject/);
    }
    expect(read("docs/build-plan.md")).toContain("plantillas fuera de `infra/auth-email.ts` (se mudan a `packages/bff/src/auth-triggers/messages/`, WP-50)");
  });

  it("is the file the neutral-surfaces guard scans for the pool's visible texts", () => {
    expect(read("scripts/lint/neutral-surfaces.ts")).toContain('"infra/auth-email.ts"');
    expect(findNeutralHits(read("infra/auth-email.ts"))).toEqual([]);
  });
});
