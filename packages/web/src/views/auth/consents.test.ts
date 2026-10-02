import { CONSENT_KINDS, CONSENT_REQUIRED, consentPlainText } from "@legajo/shared/consent-texts";
import { LEGAL_VERSIONS } from "@legajo/shared/legal-versions";
import { SignupStartInput } from "@legajo/shared/signup";
import { describe, expect, it } from "vitest";
import { accessFailureOf } from "./signup-api";
import { EMPTY_SIGNUP, type SignupForm, startInputOf, validateSignup } from "./signup-model";

const FORM: SignupForm = { ...EMPTY_SIGNUP, email: "ana.prueba@sim.legajo.demo.craftech.io", password: "Clave-de-Prueba-2026!" };
const CONTEXT = { formToken: "form-token-0123456789abcdef", lang: "es", attribution: {} } as const;

describe("[FL-119] consent variants of the sign-up", () => {
  it("[FL-119] starts with both boxes unticked; only the terms are required", () => {
    expect(EMPTY_SIGNUP.terms).toBe(false);
    expect(EMPTY_SIGNUP.contact).toBe(false);
    expect(CONSENT_REQUIRED).toEqual({ terms: true, contact: false });
  });

  it("[FL-119] (a) refuses to send without the terms, before anything leaves the browser", () => {
    expect(validateSignup(FORM)).toEqual({ terms: { kind: "consentTerms" } });
    expect(validateSignup({ ...FORM, contact: true })).toEqual({ terms: { kind: "consentTerms" } });
  });

  it("[FL-119] (b) terms only: contact goes as false, with the versions of the texts on screen", () => {
    const input = startInputOf({ ...FORM, terms: true }, CONTEXT);
    expect(input.consents).toEqual({ terms: true, contact: false });
    expect(input.consentVersions).toEqual(LEGAL_VERSIONS);
    expect(SignupStartInput.safeParse(input).success).toBe(true);
  });

  it("[FL-119] (c) both boxes: contact goes as true", () => {
    const input = startInputOf({ ...FORM, terms: true, contact: true }, { ...CONTEXT, lang: "en" });
    expect(input.consents).toEqual({ terms: true, contact: true });
    expect(input.lang).toBe("en");
    expect(SignupStartInput.safeParse(input).success).toBe(true);
  });

  it("[FL-119] (d) texts that changed while the page was open ask for a reload", () => {
    const refused = { message: "outdated", data: { code: "BAD_REQUEST", httpStatus: 400, reason: "CONSENT_VERSIONS_OUTDATED", correlationId: "c-1" } };
    expect(accessFailureOf(refused)).toEqual({ kind: "staleTexts" });
  });

  it("[FL-119] labels each box with the single source of its words, in both languages", () => {
    for (const kind of CONSENT_KINDS) {
      expect(consentPlainText(kind, "es")).toMatch(/\S/);
      expect(consentPlainText(kind, "en")).toMatch(/\S/);
      expect(consentPlainText(kind, "es")).not.toBe(consentPlainText(kind, "en"));
    }
  });
});
