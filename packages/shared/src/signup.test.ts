import { describe, expect, it } from "vitest";
import { SIGNUP_OPTIONAL_MAX_CHARS } from "./guest-limits";
import { PASSWORD_POLICY, passwordProblems } from "./password-policy";
import {
  ConsentVersions,
  GuestWorldState,
  SignupBranch,
  SignupConfirmInput,
  SignupEmail,
  SignupStartInput,
  SignupStartOutput,
  sanitizeReferrer,
  sanitizeUtm,
} from "./signup";
import { pipeList, readDoc, tableRows } from "./testing";

const ADR = readDoc("docs/adr/0015-alta-publica-de-invitados-y-leads.md");
const CATALOG = readDoc("docs/tool-catalog.md");
const VERSIONS = { terms: "2026-09-26", privacy: "2026-09-26", contact: "2026-09-26" };
const PASSWORD = "Quince-Caballos-7";

const form = (overrides: Record<string, unknown> = {}) => ({
  formToken: "f".repeat(40),
  email: " Ana.Gomez@Example-Fict.com.ar ",
  password: PASSWORD,
  consents: { terms: true, contact: false },
  consentVersions: VERSIONS,
  lang: "es",
  website: "",
  ...overrides,
});

describe("[FL-101] signup.start input", () => {
  it("normalizes the email and treats empty optional fields as absent", () => {
    const parsed = SignupStartInput.parse(form({ name: "  ", company: "Despachos del Sur (ficticio)" }));
    expect(parsed.email).toBe("ana.gomez@example-fict.com.ar");
    expect(parsed.name).toBeUndefined();
    expect(parsed.company).toBe("Despachos del Sur (ficticio)");
  });

  it("[FL-119] refuses the form without the terms box, with an unknown field or with an outdated version shape", () => {
    expect(SignupStartInput.safeParse(form({ consents: { terms: false, contact: true } })).success).toBe(false);
    expect(SignupStartInput.safeParse(form({ consents: { contact: true } })).success).toBe(false);
    expect(SignupStartInput.safeParse(form({ admin: true })).success).toBe(false);
    expect(ConsentVersions.safeParse({ ...VERSIONS, terms: "v2" }).success).toBe(false);
  });

  it("refuses a malformed email, a long optional field, control characters and a weak password", () => {
    expect(SignupStartInput.safeParse(form({ email: "ana@" })).success).toBe(false);
    expect(SignupStartInput.safeParse(form({ name: "x".repeat(SIGNUP_OPTIONAL_MAX_CHARS + 1) })).success).toBe(false);
    expect(SignupStartInput.safeParse(form({ jobTitle: "Jefa\u0007" })).success).toBe(false);
    expect(SignupStartInput.safeParse(form({ password: "corta" })).success).toBe(false);
    expect(SignupEmail.safeParse(`${"a".repeat(250)}@b.co`).success).toBe(false);
  });

  it("[FL-113] accepts a filled honeypot: the refusal happens later and silently", () => {
    expect(SignupStartInput.safeParse(form({ website: "https://spam.example" })).success).toBe(true);
  });
});

describe("password policy (the pool's, one source)", () => {
  it("names each broken rule and accepts a compliant password", () => {
    expect(passwordProblems(PASSWORD)).toEqual([]);
    expect(passwordProblems("a".repeat(PASSWORD_POLICY.minLength - 1))).toEqual(["LENGTH", "UPPERCASE", "NUMBER", "SYMBOL"]);
    expect(passwordProblems(` ${PASSWORD}`)).toEqual(["EDGE_SPACE"]);
    expect(passwordProblems("QUINCECABALLOS7!")).toEqual(["LOWERCASE"]);
  });

  it("signup.confirm carries the password again and the six-digit code", () => {
    expect(SignupConfirmInput.safeParse({ signupId: "01J9ZQXA7Q2W3E4R5T6Y7V8H9G", code: "123456", password: PASSWORD }).success).toBe(true);
    expect(SignupConfirmInput.safeParse({ signupId: "x", code: "12345", password: PASSWORD }).success).toBe(false);
  });
});

describe("[FL-130] attribution", () => {
  it("keeps only clean utm values and drops the rest", () => {
    expect(sanitizeUtm({ source: "linkedin", medium: "social post", campaign: "<script>", term: "x".repeat(101) })).toEqual({ source: "linkedin", medium: "social post" });
    expect(sanitizeUtm(undefined)).toEqual({});
  });

  it("reduces the referrer to scheme and host and drops our own origin", () => {
    expect(sanitizeReferrer("https://www.Search.example/q?x=1#y", "https://legajo.demo.craftech.io")).toBe("https://www.search.example");
    expect(sanitizeReferrer("https://legajo.demo.craftech.io/legal/terms.html", "https://legajo.demo.craftech.io")).toBeUndefined();
    expect(sanitizeReferrer("javascript:alert(1)", "https://legajo.demo.craftech.io")).toBeUndefined();
    expect(sanitizeReferrer("not a url", "https://legajo.demo.craftech.io")).toBeUndefined();
  });
});

describe("one sign-up flow (ADR-0015 §1.4)", () => {
  it("signup.start answers CODE_SENT, RATE_LIMITED or CAPACITY, nothing else", () => {
    expect(SignupStartOutput.options.map((option) => option.shape.status.value)).toEqual(["CODE_SENT", "RATE_LIMITED", "CAPACITY"]);
    expect(CATALOG).not.toMatch(/WAITLIST/);
  });

  it("branches are the rows of ADR-0015 §1.2 plus the suppression and the failed dispatch", () => {
    const tableBranches = tableRows(ADR, "| Usuario encontrado | Rama").map((cells) => (cells[1] ?? "").replaceAll("`", ""));
    expect([...new Set(tableBranches)]).toEqual(SignupBranch.options.filter((branch) => branch !== "SUPPRESSED" && branch !== "FAILED"));
  });

  it("the world states are those of account.world", () => {
    expect(GuestWorldState.options).toEqual(pipeList(CATALOG, /`\{state: "(NONE" \\\| "CREATING[^}]*FAILED)"/));
  });
});
