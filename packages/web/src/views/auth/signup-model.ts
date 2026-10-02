// Rules of `/signup` without React (docs/landing-spec.md §8.2, FL-101, FL-113, FL-119): the empty form
// (both consent boxes unticked), the field errors from the same zod schema the BFF runs
// (packages/shared/src/signup.ts), the request `signup.start` gets, what survives WAF's reload, and
// what each answer does. Every cap comes from the shared contract.
import { LEGAL_VERSIONS } from "@legajo/shared/legal-versions";
import { SIGNUP_OPTIONAL_MAX_CHARS } from "@legajo/shared/guest-limits";
import { SignupStartInput, type SignupStartOutput } from "@legajo/shared/signup";
import type { Language } from "@legajo/shared";
import type { ChallengeDraft } from "../../lib/waf";
import type { Attribution } from "../landing/utm";
import { minutesOf } from "./verify-model";

/** The fields of the form that are not secret: what survives a full page load of `/signup`. */
export interface SignupFields {
  readonly email: string;
  readonly name: string;
  readonly company: string;
  readonly jobTitle: string;
  readonly terms: boolean;
  readonly contact: boolean;
}

export interface SignupForm extends SignupFields {
  readonly password: string;
  /** Honeypot: off screen, a person never fills it. */
  readonly website: string;
}

export const EMPTY_SIGNUP: SignupForm = { email: "", password: "", name: "", company: "", jobTitle: "", terms: false, contact: false, website: "" };

export const SIGNUP_FIELDS = ["email", "password", "name", "company", "jobTitle", "terms"] as const;
export type SignupField = (typeof SIGNUP_FIELDS)[number];

export type FieldError = { readonly kind: "email" } | { readonly kind: "password" } | { readonly kind: "tooLong"; readonly max: number } | { readonly kind: "consentTerms" };

export type FieldErrors = Partial<Record<SignupField, FieldError>>;

/** The part of the BFF's schema a person fills in; `formToken`, `lang` and attribution come from the page. */
const PersonFields = SignupStartInput.pick({ email: true, password: true, name: true, company: true, jobTitle: true, consents: true });

/** Field errors of `form`, with the same schema `signup.start` validates against. */
export function validateSignup(form: SignupForm): FieldErrors {
  const parsed = PersonFields.safeParse({
    email: form.email,
    password: form.password,
    name: form.name,
    company: form.company,
    jobTitle: form.jobTitle,
    consents: { terms: form.terms, contact: form.contact },
  });
  if (parsed.success) return {};
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const head = issue.path[0];
    if (head === "email") errors.email = { kind: "email" };
    else if (head === "password") errors.password = { kind: "password" };
    else if (head === "name" || head === "company" || head === "jobTitle") errors[head] = { kind: "tooLong", max: SIGNUP_OPTIONAL_MAX_CHARS };
    else if (head === "consents") errors.terms = { kind: "consentTerms" };
  }
  return errors;
}

/** Fields the BFF named in an `INVALID` answer, as the form's own fields. */
export function errorsFromServer(fields: readonly string[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of fields) {
    if (field === "email") errors.email = { kind: "email" };
    else if (field === "password") errors.password = { kind: "password" };
    else if (field === "name" || field === "company" || field === "jobTitle") errors[field] = { kind: "tooLong", max: SIGNUP_OPTIONAL_MAX_CHARS };
    else if (field === "consents") errors.terms = { kind: "consentTerms" };
  }
  return errors;
}

export interface StartContext {
  readonly formToken: string;
  readonly lang: Language;
  readonly attribution: Attribution;
}

/** What `signup.start` receives: the form, the versions of the texts on screen, language and origin of the visit. */
export function startInputOf(form: SignupForm, context: StartContext): SignupStartInput {
  const optional = (value: string) => (value.trim() === "" ? undefined : value.trim());
  const name = optional(form.name);
  const company = optional(form.company);
  const jobTitle = optional(form.jobTitle);
  const utm = context.attribution.utm;
  return {
    formToken: context.formToken,
    email: form.email,
    password: form.password,
    ...(name !== undefined ? { name } : {}),
    ...(company !== undefined ? { company } : {}),
    ...(jobTitle !== undefined ? { jobTitle } : {}),
    consents: { terms: true, contact: form.contact },
    consentVersions: { ...LEGAL_VERSIONS },
    lang: context.lang,
    ...(utm !== undefined && Object.keys(utm).length > 0 ? { utm: { ...utm } } : {}),
    ...(context.attribution.referrer ? { referrer: context.attribution.referrer } : {}),
    website: form.website,
  };
}

/** What a WAF reload keeps: everything but the password and the honeypot. */
export function draftOf(form: SignupForm): ChallengeDraft {
  return { email: form.email, name: form.name, company: form.company, jobTitle: form.jobTitle, terms: form.terms, contact: form.contact };
}

function text(draft: ChallengeDraft, key: string): string {
  const value = draft[key];
  return typeof value === "string" ? value : "";
}

/** The form after a WAF reload: the kept fields, an empty password. */
export function formFromDraft(draft: ChallengeDraft): SignupForm {
  return {
    ...EMPTY_SIGNUP,
    email: text(draft, "email"),
    name: text(draft, "name"),
    company: text(draft, "company"),
    jobTitle: text(draft, "jobTitle"),
    terms: draft.terms === true,
    contact: draft.contact === true,
  };
}

/** The draft "Cambiar email", "Empezar de nuevo" or an unverified sign-in carry to `/signup`. */
export function draftOfFields(fields: Partial<SignupFields>): ChallengeDraft {
  return draftOf({ ...EMPTY_SIGNUP, ...fields });
}

export type StartOutcome =
  | { readonly kind: "codeSent"; readonly signupId: string; readonly resendAvailableAt: number }
  | { readonly kind: "rateLimited"; readonly minutes: number }
  | { readonly kind: "capacity" };

/** `CODE_SENT` the same for a new email and one with an account; the limits say nothing about it. */
export function startOutcome(answer: SignupStartOutput, now: number): StartOutcome {
  switch (answer.status) {
    case "CODE_SENT":
      return { kind: "codeSent", signupId: answer.signupId, resendAvailableAt: now + answer.resendAfterSec * 1000 };
    case "RATE_LIMITED":
      return { kind: "rateLimited", minutes: minutesOf(answer.retryAfterSec) };
    case "CAPACITY":
      return { kind: "capacity" };
  }
}
