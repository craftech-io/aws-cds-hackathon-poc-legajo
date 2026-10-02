// `/forgot` and `/forgot/reset` (docs/landing-spec.md §8.6, FL-107): `ForgotPassword` and
// `ConfirmForgotPassword` from the browser, in the person's language. Any answer of Cognito reads like a
// success ("Si hay una cuenta con ese dato…") and goes on to the code, so the screens never tell whether
// an email has an account; only a network failure stays. Another code can be asked for after the same
// wait as the sign-up's. The reserved guest accounts have no email: the general text covers them.
import { RESEND_WAIT_SECONDS } from "@legajo/shared/guest-limits";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSession } from "../../context/SessionContext";
import { looksLikeEmail } from "../../lib/auth/credentials";
import { flowDeps } from "../../lib/auth/deps";
import type { AuthFlowErrorCode } from "../../lib/auth/errors";
import { type AuthFlowAction, advance } from "../../lib/auth/flow";
import { Link, useRouter } from "../../lib/router";
import { FORGOT_RESET_PATH, LOGIN_PATH } from "../../routes";
import { AuthLangProvider, useAuthLang } from "./AuthLang";
import { AuthLayout } from "./AuthLayout";
import { CodeField, ErrorNote, Field, LinkButton, NoticeNote, PasswordField, PasswordRules, StepHeading, SubmitButton } from "./form-parts";
import { holdLoginEmail } from "./handoff";
import { hrefWithLang } from "./lang";
import { completeCode, resendState } from "./verify-model";

// The reset in progress, between the two screens of this tab: memory only.
const resetMemory: { email?: string; resendAvailableAt?: number } = {};

function useFlowDeps() {
  const { auth } = useSession();
  return useMemo(() => (auth ? flowDeps(auth.cognito, auth.srp, { kind: "signIn" }) : undefined), [auth]);
}

function ForgotScreen() {
  const { lang, copy } = useAuthLang();
  const { navigate } = useRouter();
  const deps = useFlowDeps();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFlowErrorCode | undefined>(undefined);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!deps || busy || !looksLikeEmail(email)) return;
    setBusy(true);
    const transition = await advance({ step: "forgotRequest" }, { type: "requestReset", email, lang }, deps);
    setBusy(false);
    if (transition.state.step === "forgotConfirm") {
      resetMemory.email = transition.state.email;
      resetMemory.resendAvailableAt = Date.now() + RESEND_WAIT_SECONDS * 1000;
      navigate(hrefWithLang(FORGOT_RESET_PATH, lang));
      return;
    }
    setError(transition.error);
  };

  return (
    <form className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
      <StepHeading title={copy.forgot.title} lead={copy.forgot.lead} />
      {error ? <ErrorNote>{copy.flowErrors[error]}</ErrorNote> : null}
      <Field label={copy.forgot.email} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} required />
      <SubmitButton busy={busy}>{copy.forgot.submit}</SubmitButton>
      <p className="text-center">
        <Link to={hrefWithLang(LOGIN_PATH, lang)} className="inline-flex min-h-11 items-center text-sm font-semibold text-signal-ink underline-offset-4 hover:underline">
          {copy.reset.back}
        </Link>
      </p>
    </form>
  );
}

function useTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function ResetScreen() {
  const { lang, copy } = useAuthLang();
  const { navigate } = useRouter();
  const deps = useFlowDeps();
  const [email, setEmail] = useState(resetMemory.email ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFlowErrorCode | undefined>(undefined);
  const [resent, setResent] = useState(false);
  const [availableAt, setAvailableAt] = useState(resetMemory.resendAvailableAt ?? 0);
  const now = useTick();
  // The reset has no cap of its own here: Cognito's quota of account emails is the limit.
  const resend = resendState(now, availableAt, 0, Number.POSITIVE_INFINITY);

  const run = async (action: AuthFlowAction) => {
    if (!deps || busy || !looksLikeEmail(email)) return undefined;
    setBusy(true);
    setResent(false);
    const transition = await advance({ step: "forgotConfirm", email }, action, deps);
    setBusy(false);
    setError(transition.error);
    return transition;
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const digits = completeCode(code);
    if (!digits) {
      setError("INVALID_CODE");
      return;
    }
    const transition = await run({ type: "confirmReset", code: digits, password });
    if (transition?.state.step === "credentials") {
      delete resetMemory.email;
      holdLoginEmail(email.trim().toLowerCase());
      navigate(hrefWithLang(LOGIN_PATH, lang, new URLSearchParams("reset=1")));
    } else setCode("");
  };

  const onResend = async () => {
    const transition = await run({ type: "resendReset", lang });
    if (transition?.state.step === "forgotConfirm") {
      const next = Date.now() + RESEND_WAIT_SECONDS * 1000;
      resetMemory.resendAvailableAt = next;
      setAvailableAt(next);
      setResent(true);
    }
  };

  const errorText = error === "INVALID_CODE" ? copy.reset.errors.invalid : error ? copy.flowErrors[error] : undefined;
  return (
    <form className="space-y-4" onSubmit={(event) => void onSubmit(event)} noValidate>
      <StepHeading title={copy.reset.title} />
      <NoticeNote>{resent ? copy.verify.resent : copy.forgot.sent}</NoticeNote>
      {errorText ? <ErrorNote>{errorText}</ErrorNote> : null}
      {resetMemory.email === undefined ? (
        <Field label={copy.reset.email} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} required />
      ) : null}
      <CodeField label={copy.reset.code} value={code} onChange={setCode} />
      <PasswordField label={copy.reset.password} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      <PasswordRules password={password} />
      <SubmitButton busy={busy}>{copy.reset.submit}</SubmitButton>
      <div className="flex flex-col items-center gap-1 text-sm">
        <LinkButton onClick={() => void onResend()} disabled={busy || resend.kind !== "ready"}>
          {copy.verify.resend}
        </LinkButton>
        {resend.kind === "wait" ? <p className="text-ink-muted">{copy.verify.resendIn(resend.seconds)}</p> : null}
        <Link to={hrefWithLang(LOGIN_PATH, lang)} className="inline-flex min-h-11 items-center font-semibold text-signal-ink underline-offset-4 hover:underline">
          {copy.reset.back}
        </Link>
      </div>
    </form>
  );
}

export function ForgotView() {
  return (
    <AuthLangProvider title="forgot">
      <AuthLayout>
        <ForgotScreen />
      </AuthLayout>
    </AuthLangProvider>
  );
}

export function ResetView() {
  return (
    <AuthLangProvider title="reset">
      <AuthLayout>
        <ResetScreen />
      </AuthLayout>
    </AuthLangProvider>
  );
}
