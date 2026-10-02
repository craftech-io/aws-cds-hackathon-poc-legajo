// The account emails (ADR-0015 §7, FL-120, FL-124): es and en with the same keys, Cognito's placeholder
// in every one, "if you did not ask for it, ignore this message", the neutral footer with the privacy
// policy, links only to the demo's domain, no role names, none of ADR-0014's words, within Cognito's sizes.
import { describe, expect, it } from "vitest";
import { STAGE_DOMAIN } from "@legajo/shared";
import { findNeutralHits } from "../../../../../scripts/lint/neutral-words";
import { CHROME, TEXTS } from "./copy";
import { type AccountEmailKind, COGNITO_CODE, COGNITO_EMAIL_MAX_CHARS, COGNITO_SUBJECT_MAX_CHARS, COGNITO_USERNAME, PRIVACY_URL, accountEmail } from "./index";

const KINDS = Object.keys(TEXTS.es) as AccountEmailKind[];
const LANGS = ["es", "en"] as const;

describe("[FL-124] neutral account emails", () => {
  it.each(LANGS.flatMap((lang) => KINDS.map((kind) => [lang, kind] as const)))("%s %s", (lang, kind) => {
    const email = accountEmail(kind, lang);
    expect(email.message).toContain(COGNITO_CODE);
    if (kind === "INVITATION") expect(email.message).toContain(COGNITO_USERNAME);
    expect(email.message).toContain(CHROME[lang].ignore);
    expect(email.message).toContain(CHROME[lang].footer);
    expect(email.message).toContain(PRIVACY_URL);
    expect(email.subject.length).toBeLessThanOrEqual(COGNITO_SUBJECT_MAX_CHARS);
    expect(email.message.length).toBeLessThanOrEqual(COGNITO_EMAIL_MAX_CHARS);
    for (const href of email.message.matchAll(/(?:href|src)="([^"]+)"/g)) expect(new URL(href[1] ?? "").host).toBe(STAGE_DOMAIN);
    expect(`${email.subject}\n${email.message}`).not.toMatch(/\b(?:BROKER|ANALYST|GUEST)\b/);
    expect(findNeutralHits(`${email.subject}\n${email.message}`)).toEqual([]);
  });

  it("the footer names the brand and the synthetic data", () => {
    expect(CHROME.es.footer).toBe("Legajo listo · Powered by Craftech · datos 100 % sintéticos");
    expect(CHROME.es.ignore).toBe("Si no lo pediste, ignorá este mensaje.");
  });
});

describe("[FL-120] es and en", () => {
  it("have the same keys and the same kinds", () => {
    expect(Object.keys(TEXTS.en).sort()).toEqual(Object.keys(TEXTS.es).sort());
    for (const kind of KINDS) expect(Object.keys(TEXTS.en[kind]).sort()).toEqual(Object.keys(TEXTS.es[kind]).sort());
    expect(Object.keys(CHROME.en).sort()).toEqual(Object.keys(CHROME.es).sort());
  });

  it("the English emails are in English, with the subject of the spec", () => {
    expect(accountEmail("EXISTING_ACCOUNT", "en").subject).toBe("You already have a Legajo listo account");
    expect(accountEmail("SIGNUP_CODE", "en").message).toContain('lang="en"');
    expect(accountEmail("SIGNUP_CODE", "es").message).toContain('lang="es-AR"');
  });
});
