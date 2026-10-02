// `/signup` (docs/landing-spec.md §8.2, ADR-0015 §1, FL-101, FL-112, FL-113, FL-119): email and
// password, three optional fields, the two consent boxes unticked, the hidden honeypot. The page asks
// `signup.form` for its signed `formToken` on arrival and sends `signup.start` alone (lib/trpc.ts). The
// answer is the same for a new email and one with an account: `/signup/verify` either way. The browser
// never calls Cognito's `SignUp`. A WAF challenge reloads the page once, keeping the fields that are not
// secret; the password stays only in memory for the next screen.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSession } from "../../context/SessionContext";
import { normalizeEmail } from "../../lib/auth/credentials";
import { Link, Redirect, useRouter } from "../../lib/router";
import { challengeOutcome, challengeRetryUrl, isChallengeRetry, saveChallengeDraft, takeChallengeDraft } from "../../lib/waf";
import { LOGIN_PATH, SIGNUP_VERIFY_PATH } from "../../routes";
import { readAttribution } from "../landing/utm";
import { AccessNotice, type AccessState } from "./AccessNotice";
import { AuthLangProvider, useAuthLang } from "./AuthLang";
import { AuthLayout } from "./AuthLayout";
import type { AuthCopy } from "./copy";
import { ConsentCheckbox } from "./ConsentCheckbox";
import { ErrorNote, Field, NoticeNote, PasswordField, PasswordRules, StepHeading, SubmitButton } from "./form-parts";
import { holdPassword, savePendingSignup } from "./handoff";
import { hrefWithLang } from "./lang";
import { accessFailureOf, requestFormToken, startSignup } from "./signup-api";
import { resumeTarget } from "./VerifyView";
import { cameUnconfirmed } from "./session";
import {
  EMPTY_SIGNUP,
  type FieldError,
  type FieldErrors,
  SIGNUP_FIELDS,
  type SignupField,
  type SignupForm,
  draftOf,
  errorsFromServer,
  formFromDraft,
  startInputOf,
  startOutcome,
  validateSignup,
} from "./signup-model";

const IDS: Readonly<Record<SignupField | "contact" | "website", string>> = {
  email: "signup-email",
  password: "signup-password",
  name: "signup-name",
  company: "signup-company",
  jobTitle: "signup-job-title",
  terms: "signup-terms",
  contact: "signup-contact",
  website: "signup-website",
};

function errorText(copy: AuthCopy, error: FieldError): string {
  switch (error.kind) {
    case "email":
      return copy.signup.errors.email;
    case "password":
      return copy.signup.errors.password;
    case "tooLong":
      return copy.signup.errors.tooLong(error.max);
    case "consentTerms":
      return copy.signup.errors.consentTerms;
  }
}

function fieldLabel(copy: AuthCopy, field: SignupField): string {
  return field === "terms" ? copy.layout.terms : copy.signup[field];
}

// The fields kept across the full page load: after WAF's challenge (`?retry=1`), or brought back by
// "Cambiar email", "Empezar de nuevo" or a sign-in whose email is not verified yet.
function initialForm(search: URLSearchParams): { readonly form: SignupForm; readonly retried: boolean } {
  const draft = takeChallengeDraft();
  return { form: draft ? formFromDraft(draft) : EMPTY_SIGNUP, retried: isChallengeRetry(search) };
}

type PageNotice = AccessState | { readonly kind: "staleTexts" } | { readonly kind: "generic" };

function SignupScreen() {
  const { lang, copy } = useAuthLang();
  const { trpc } = useSession();
  const { path, search, navigate } = useRouter();
  const [start] = useState(() => initialForm(search));
  const [form, setForm] = useState<SignupForm>(start.form);
  const [formToken, setFormToken] = useState<string | undefined>(undefined);
  const [touched, setTouched] = useState<ReadonlySet<SignupField>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<PageNotice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [summaryFocus, setSummaryFocus] = useState(0);
  const summary = useRef<HTMLDivElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const latest = useRef(form);
  latest.current = form;

  // A WAF challenge reloads /signup once; a second one means this browser cannot pass it.
  const onChallenge = (current: SignupForm) => {
    if (challengeOutcome(search) === "failed") {
      setNotice({ kind: "challenge" });
      return;
    }
    saveChallengeDraft(draftOf(current));
    window.location.assign(challengeRetryUrl(path, search));
  };

  useEffect(() => {
    let active = true;
    requestFormToken(trpc, lang)
      .then((token) => {
        if (active) setFormToken(token);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const failure = accessFailureOf(error);
        if (failure.kind === "challenge") onChallenge(latest.current);
        else setNotice(failure.kind === "rateLimitedEdge" || failure.kind === "offline" ? { kind: failure.kind } : { kind: "generic" });
      });
    return () => {
      active = false;
    };
    // One token per visit of the page: the language switch keeps it.
  }, [trpc]);

  useEffect(() => {
    if (start.retried) password.current?.focus();
  }, [start.retried]);

  useEffect(() => {
    if (summaryFocus > 0) summary.current?.focus();
  }, [summaryFocus]);

  const errors: FieldErrors = { ...validateSignup(form), ...serverErrors };
  const shown = SIGNUP_FIELDS.filter((field) => errors[field] !== undefined && (submitted || touched.has(field)));
  const errorOf = (field: SignupField) => (shown.includes(field) && errors[field] ? errorText(copy, errors[field]) : undefined);
  const blur = (field: SignupField) => () => setTouched((current) => new Set(current).add(field));
  const update = <K extends keyof SignupForm>(key: K, value: SignupForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key in serverErrors) setServerErrors((current) => ({ ...current, [key]: undefined }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setNotice(undefined);
    if (Object.keys(validateSignup(form)).length > 0) {
      setSummaryFocus((count) => count + 1);
      return;
    }
    if (!formToken) {
      setNotice({ kind: "generic" });
      return;
    }
    setBusy(true);
    try {
      const answer = await startSignup(trpc, startInputOf(form, { formToken, lang, attribution: readAttribution() }));
      const outcome = startOutcome(answer, Date.now());
      if (outcome.kind === "codeSent") {
        const fields = { name: form.name, company: form.company, jobTitle: form.jobTitle, terms: form.terms, contact: form.contact };
        savePendingSignup({ signupId: outcome.signupId, email: normalizeEmail(form.email), resendAvailableAt: outcome.resendAvailableAt, resends: 0, fields });
        holdPassword(form.password);
        navigate(hrefWithLang(SIGNUP_VERIFY_PATH, lang));
        return;
      }
      setNotice(outcome.kind === "rateLimited" ? { kind: "rateLimited", minutes: outcome.minutes } : { kind: "signupPaused" });
    } catch (error) {
      const failure = accessFailureOf(error);
      if (failure.kind === "challenge") onChallenge(form);
      else if (failure.kind === "invalid") setServerErrors(errorsFromServer(failure.fields));
      else if (failure.kind === "staleTexts") setNotice({ kind: "staleTexts" });
      else if (failure.kind === "rateLimitedEdge" || failure.kind === "offline") setNotice({ kind: failure.kind });
      else if (failure.kind === "unexpected") setNotice(failure);
      else setNotice({ kind: "generic" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-5" onSubmit={(event) => void onSubmit(event)} noValidate>
      <StepHeading title={copy.signup.title} lead={copy.signup.lead} />
      {start.retried && !notice ? <NoticeNote>{copy.signup.retryNotice}</NoticeNote> : null}
      {!start.retried && cameUnconfirmed(search) && !notice ? <NoticeNote>{copy.login.errors.unconfirmedRestart}</NoticeNote> : null}
      {notice?.kind === "staleTexts" ? (
        <ErrorNote>
          <p>{copy.signup.errors.staleTexts}</p>
          <button type="button" className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-2" onClick={() => window.location.reload()}>
            {copy.signup.errors.reload}
          </button>
        </ErrorNote>
      ) : null}
      {notice?.kind === "generic" ? <ErrorNote>{copy.signup.errors.generic}</ErrorNote> : null}
      {notice && notice.kind !== "staleTexts" && notice.kind !== "generic" ? <AccessNotice state={notice} /> : null}
      {submitted && shown.length > 0 ? (
        <div ref={summary} tabIndex={-1} role="alert" className="rounded-card border-l-4 border-danger bg-danger-soft px-3 py-2 text-sm text-ink">
          <p className="font-semibold">{copy.signup.errors.summary(shown.length)}</p>
          <ul className="mt-1 list-disc pl-5">
            {shown.map((field) => (
              <li key={field}>
                <a href={`#${IDS[field]}`} className="underline underline-offset-2">
                  {fieldLabel(copy, field)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Field
        id={IDS.email}
        label={copy.signup.email}
        hint={copy.signup.emailHint}
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        value={form.email}
        onChange={(event) => update("email", event.target.value)}
        onBlur={blur("email")}
        required
        {...(errorOf("email") !== undefined ? { error: errorOf("email") } : {})}
      />
      <div className="space-y-2">
        <PasswordField
          ref={password}
          id={IDS.password}
          label={copy.signup.password}
          autoComplete="new-password"
          value={form.password}
          onChange={(event) => update("password", event.target.value)}
          onBlur={blur("password")}
          required
          {...(errorOf("password") !== undefined ? { error: errorOf("password") } : {})}
        />
        <PasswordRules password={form.password} />
      </div>
      <fieldset className="space-y-4 rounded-card border border-rule p-4">
        <legend className="px-1 text-sm font-semibold text-ink">{copy.signup.optionalGroup}</legend>
        {(["name", "company", "jobTitle"] as const).map((field) => (
          <Field
            key={field}
            id={IDS[field]}
            label={copy.signup[field]}
            type="text"
            autoComplete={field === "name" ? "name" : field === "company" ? "organization" : "organization-title"}
            value={form[field]}
            onChange={(event) => update(field, event.target.value)}
            onBlur={blur(field)}
            {...(errorOf(field) !== undefined ? { error: errorOf(field) } : {})}
          />
        ))}
      </fieldset>
      <div className="space-y-3">
        <ConsentCheckbox
          id={IDS.terms}
          kind="terms"
          checked={form.terms}
          onChange={(checked) => update("terms", checked)}
          onBlur={blur("terms")}
          {...(errorOf("terms") !== undefined ? { error: errorOf("terms") } : {})}
        />
        <ConsentCheckbox id={IDS.contact} kind="contact" checked={form.contact} onChange={(checked) => update("contact", checked)} hint={copy.signup.consentContactHint} />
      </div>
      <div aria-hidden="true" className="sr-only">
        <label htmlFor={IDS.website}>{copy.signup.honeypot}</label>
        <input id={IDS.website} name="website" type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={(event) => update("website", event.target.value)} />
      </div>
      <p className="text-sm text-ink-muted">{copy.signup.syntheticNote}</p>
      <SubmitButton busy={busy} busyLabel={copy.signup.submitting}>
        {copy.signup.submit}
      </SubmitButton>
      <p className="text-center text-sm">
        <Link to={hrefWithLang(LOGIN_PATH, lang)} className="inline-flex min-h-11 items-center font-semibold text-signal-ink underline-offset-4 hover:underline">
          {copy.signup.haveAccount}
        </Link>
      </p>
    </form>
  );
}

export function SignupView() {
  const { search } = useRouter();
  const resume = resumeTarget(search);
  if (resume) return <Redirect to={resume} />;
  return (
    <AuthLangProvider title="signup">
      <AuthLayout>
        <SignupScreen />
      </AuthLayout>
    </AuthLangProvider>
  );
}
