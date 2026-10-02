import { SIGNUP_OPTIONAL_MAX_CHARS } from "@legajo/shared/guest-limits";
import { SignupStartInput } from "@legajo/shared/signup";
import { describe, expect, it } from "vitest";
import { accessFailureOf } from "./signup-api";
import { EMPTY_SIGNUP, type SignupForm, draftOf, draftOfFields, errorsFromServer, formFromDraft, startInputOf, startOutcome, validateSignup } from "./signup-model";
import { WafBlockedError, WafChallengeError } from "../../lib/waf";

const FORM: SignupForm = {
  ...EMPTY_SIGNUP,
  email: "  Ana.Prueba@Sim.Legajo.Demo.Craftech.io ",
  password: "Clave-de-Prueba-2026!",
  terms: true,
};
const CONTEXT = { formToken: "form-token-0123456789abcdef", lang: "es", attribution: {} } as const;

describe("[FL-101] the sign-up form", () => {
  it("[FL-101] checks the email, the password policy and the optional fields with the BFF's own schema", () => {
    expect(validateSignup(FORM)).toEqual({});
    expect(validateSignup({ ...FORM, email: "no-es-un-email" })).toEqual({ email: { kind: "email" } });
    expect(validateSignup({ ...FORM, password: "corta" })).toEqual({ password: { kind: "password" } });
    expect(validateSignup({ ...FORM, password: " Clave-de-Prueba-2026!" })).toEqual({ password: { kind: "password" } });
    const tooLong = "x".repeat(SIGNUP_OPTIONAL_MAX_CHARS + 1);
    expect(validateSignup({ ...FORM, name: tooLong, company: tooLong, jobTitle: tooLong })).toEqual({
      name: { kind: "tooLong", max: SIGNUP_OPTIONAL_MAX_CHARS },
      company: { kind: "tooLong", max: SIGNUP_OPTIONAL_MAX_CHARS },
      jobTitle: { kind: "tooLong", max: SIGNUP_OPTIONAL_MAX_CHARS },
    });
    expect(validateSignup({ ...FORM, name: "x".repeat(SIGNUP_OPTIONAL_MAX_CHARS) })).toEqual({});
  });

  it("[FL-101] sends the optional fields only when given, the honeypot as typed and the visit's origin", () => {
    const input = startInputOf({ ...FORM, name: "  ", company: "Despachos Ficticios SRL", website: "" }, { ...CONTEXT, attribution: { utm: { source: "feria" }, referrer: "https://news.example.com" } });
    expect(input).not.toHaveProperty("name");
    expect(input.company).toBe("Despachos Ficticios SRL");
    expect(input.website).toBe("");
    expect(input.utm).toEqual({ source: "feria" });
    expect(input.referrer).toBe("https://news.example.com");
    const parsed = SignupStartInput.parse(input);
    expect(parsed.email).toBe("ana.prueba@sim.legajo.demo.craftech.io");
    expect(startInputOf(FORM, CONTEXT)).not.toHaveProperty("utm");
  });

  it("[FL-113] keeps the honeypot's value: the BFF suppresses the sign-up silently", () => {
    expect(startInputOf({ ...FORM, website: "https://spam.example" }, CONTEXT).website).toBe("https://spam.example");
  });

  it("[FL-113] keeps neither the password nor the honeypot across WAF's reload", () => {
    const draft = draftOf({ ...FORM, name: "Ana", contact: true, website: "bot" });
    expect(Object.keys(draft).sort()).toEqual(["company", "contact", "email", "jobTitle", "name", "terms"]);
    expect(formFromDraft(draft)).toEqual({ ...EMPTY_SIGNUP, email: FORM.email, name: "Ana", terms: true, contact: true });
    expect(formFromDraft(draftOfFields({ email: "otra@sim.legajo.demo.craftech.io" }))).toEqual({ ...EMPTY_SIGNUP, email: "otra@sim.legajo.demo.craftech.io" });
  });

  it("[FL-104] answers a new email and one with an account the same way", () => {
    expect(startOutcome({ status: "CODE_SENT", signupId: "01JABCDEFGHJKMNPQRSTVWXYZ0", resendAfterSec: 60 }, 1_000)).toEqual({
      kind: "codeSent",
      signupId: "01JABCDEFGHJKMNPQRSTVWXYZ0",
      resendAvailableAt: 61_000,
    });
  });

  it("[FL-112] tells the limits of the sign-up without a word about the email", () => {
    expect(startOutcome({ status: "RATE_LIMITED", retryAfterSec: 61 }, 0)).toEqual({ kind: "rateLimited", minutes: 2 });
    expect(startOutcome({ status: "CAPACITY" }, 0)).toEqual({ kind: "capacity" });
  });

  it("[FL-113] classifies WAF, form errors, the network and the unexpected", () => {
    expect(accessFailureOf(new Error("fetch", { cause: new WafChallengeError("c") }))).toEqual({ kind: "challenge" });
    expect(accessFailureOf(new Error("fetch", { cause: new WafBlockedError("b") }))).toEqual({ kind: "rateLimitedEdge" });
    const invalid = { message: "bad", data: { code: "BAD_REQUEST", reason: "INVALID", zodError: { fieldErrors: { email: ["bad"], consents: ["bad"] } } } };
    expect(accessFailureOf(invalid)).toEqual({ kind: "invalid", fields: ["email", "consents"] });
    expect(errorsFromServer(["email", "consents", "other"])).toEqual({ email: { kind: "email" }, terms: { kind: "consentTerms" } });
    expect(accessFailureOf({ message: "offline" })).toEqual({ kind: "offline" });
    expect(accessFailureOf({ message: "down", data: { code: "INTERNAL_SERVER_ERROR", correlationId: "corr-9" } })).toEqual({ kind: "unexpected", reference: "corr-9" });
  });
});
