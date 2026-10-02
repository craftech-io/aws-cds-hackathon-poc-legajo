// `/signup/verify` (docs/landing-spec.md §8.3, FL-101 to FL-104): one input for the code, sent as soon
// as it has all its digits; the email masked; "Reenviar código" with the countdown the BFF set and gone
// after the last resend of this sign-up; the same screen whatever `SignupDispatch` decided, with the
// way to sign in always visible. The password of /signup comes from memory; after a reload it is asked
// again, never read from storage. Every answer that is not `CONFIRMED` takes 1.5 s (the BFF's fixed
// deadline), so the button says "Verificando…" meanwhile.
import { RESEND_MAX_PER_SIGNUP } from "@legajo/shared/guest-limits";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSession } from "../../context/SessionContext";
import { Link, useRouter } from "../../lib/router";
import { challengeOutcome, challengeRetryUrl, saveChallengeDraft } from "../../lib/waf";
import { LOGIN_PATH, SIGNUP_PATH, SIGNUP_VERIFY_PATH } from "../../routes";
import { AccessNotice, type AccessState } from "./AccessNotice";
import { AuthLangProvider, useAuthLang } from "./AuthLang";
import { AuthLayout } from "./AuthLayout";
import { CODE_DIGITS } from "./copy";
import { CodeField, ErrorNote, LinkButton, NoticeNote, PasswordField, StepHeading, SubmitButton } from "./form-parts";
import { type PendingSignup, forgetSignup, heldPassword, holdLoginEmail, holdPassword, readPendingSignup, savePendingSignup } from "./handoff";
import { hrefWithLang } from "./lang";
import { accessFailureOf, confirmSignup, resendCode } from "./signup-api";
import { draftOfFields } from "./signup-model";
import { cameUnconfirmed } from "./session";
import { completeCode, confirmOutcome, maskEmail, resendOutcome, resendState } from "./verify-model";

/** `?resume=verify`: a WAF reload of /signup that should come back here (SignupView). */
export const RESUME_PARAM = "resume";
export const RESUME_VERIFY = "verify";

type VerifyNotice =
  | AccessState
  | { readonly kind: "invalid"; readonly attemptsLeft?: number }
  | { readonly kind: "expired" }
  | { readonly kind: "resent" }
  | { readonly kind: "resendWait"; readonly minutes: number };

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function VerifyScreen({ initial }: { readonly initial: PendingSignup }) {
  const { lang, copy } = useAuthLang();
  const { trpc } = useSession();
  const { search, navigate } = useRouter();
  const [pending, setPending] = useState(initial);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState(() => heldPassword() ?? "");
  const [askPassword] = useState(() => heldPassword() === undefined);
  const [notice, setNotice] = useState<VerifyNotice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const now = useNow(1_000);
  const resend = resendState(now, pending.resendAvailableAt, pending.resends, RESEND_MAX_PER_SIGNUP);
  const wasWaiting = useRef(resend.kind === "wait");
  const [announce, setAnnounce] = useState("");

  // The countdown is not read second by second; its end is announced once.
  useEffect(() => {
    if (wasWaiting.current && resend.kind === "ready") setAnnounce(copy.verify.resendReady);
    wasWaiting.current = resend.kind === "wait";
  }, [resend.kind, copy]);

  const keep = (next: PendingSignup) => {
    setPending(next);
    savePendingSignup(next);
  };

  // Back to the form with its fields but not the password: a full page load, as every way to /signup.
  const backToSignup = () => {
    saveChallengeDraft(draftOfFields({ email: pending.email, ...pending.fields }));
    forgetSignup();
    window.location.assign(hrefWithLang(SIGNUP_PATH, lang));
  };

  const onFailure = (error: unknown) => {
    const failure = accessFailureOf(error);
    if (failure.kind === "challenge") {
      if (challengeOutcome(search) === "failed") setNotice({ kind: "challenge" });
      else window.location.assign(`${challengeRetryUrl(SIGNUP_PATH, new URLSearchParams(lang === "en" ? "lang=en" : ""))}&${RESUME_PARAM}=${RESUME_VERIFY}`);
    } else if (failure.kind === "rateLimitedEdge" || failure.kind === "offline" || failure.kind === "unexpected") setNotice(failure);
    // A form error (a code that is not six digits): the same words as a wrong code, never more.
    else setNotice({ kind: "invalid" });
  };

  const confirm = async (digits: string) => {
    if (busy || !password) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const outcome = confirmOutcome(await confirmSignup(trpc, { signupId: pending.signupId, code: digits, password }));
      if (outcome.kind === "done") {
        forgetSignup();
        holdLoginEmail(pending.email);
        navigate(hrefWithLang(LOGIN_PATH, lang, new URLSearchParams("welcome=1")));
        return;
      }
      setCode("");
      if (outcome.kind === "invalid") setNotice({ kind: "invalid", ...(outcome.showAttempts ? { attemptsLeft: outcome.attemptsLeft } : {}) });
      else if (outcome.kind === "expired") setNotice({ kind: "expired" });
      else setNotice({ kind: "rateLimited", minutes: outcome.minutes });
    } catch (error) {
      onFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const onCode = (value: string) => {
    setCode(value);
    const digits = completeCode(value);
    if (digits && password) void confirm(digits);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const digits = completeCode(code);
    if (digits) void confirm(digits);
  };

  const onResend = async () => {
    if (busy || resend.kind !== "ready") return;
    setBusy(true);
    setNotice(undefined);
    try {
      const outcome = resendOutcome(await resendCode(trpc, pending.signupId), Date.now());
      if (outcome.kind === "sent") {
        keep({ ...pending, resends: pending.resends + 1, resendAvailableAt: outcome.availableAt });
        setNotice({ kind: "resent" });
      } else if (outcome.kind === "wait") {
        keep({ ...pending, resendAvailableAt: outcome.availableAt });
        setNotice({ kind: "resendWait", minutes: outcome.minutes });
      } else setNotice(outcome.kind === "expired" ? { kind: "expired" } : { kind: "signupPaused" });
    } catch (error) {
      onFailure(error);
    } finally {
      setBusy(false);
    }
  };

  let alert = null;
  if (notice?.kind === "invalid") {
    alert = (
      <ErrorNote>
        <p>{copy.verify.errors.invalid}</p>
        {notice.attemptsLeft !== undefined ? <p>{copy.verify.errors.attemptsLeft(notice.attemptsLeft)}</p> : null}
      </ErrorNote>
    );
  } else if (notice?.kind === "expired") {
    alert = (
      <ErrorNote>
        <p>{copy.verify.errors.expired}</p>
        <button type="button" className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-2" onClick={backToSignup}>
          {copy.verify.restart}
        </button>
      </ErrorNote>
    );
  } else if (notice?.kind === "resent") alert = <NoticeNote>{copy.verify.resent}</NoticeNote>;
  else if (notice?.kind === "resendWait") alert = <ErrorNote>{copy.verify.resendWait(notice.minutes)}</ErrorNote>;
  else if (notice) alert = <AccessNotice state={notice} />;

  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <StepHeading title={copy.verify.title} lead={copy.verify.lead(maskEmail(pending.email), CODE_DIGITS)} />
      <p className="rounded-card bg-manifest px-3 py-2 text-sm text-ink">
        {copy.verify.existingHintBefore}
        <Link to={hrefWithLang(LOGIN_PATH, lang)} className="font-semibold text-signal-ink underline underline-offset-2">
          {copy.verify.existingHintLink}
        </Link>
        {copy.verify.existingHintAfter}
      </p>
      {cameUnconfirmed(search) && !notice ? <NoticeNote>{copy.login.errors.unconfirmed}</NoticeNote> : null}
      {alert}
      {askPassword ? (
        <PasswordField
          label={copy.verify.password}
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            holdPassword(event.target.value);
          }}
          required
        />
      ) : null}
      <CodeField label={copy.verify.code} value={code} onChange={onCode} />
      <SubmitButton busy={busy} busyLabel={copy.verify.submitting}>
        {copy.verify.submit}
      </SubmitButton>
      <div className="flex flex-col items-center gap-1 text-sm">
        {resend.kind === "exhausted" ? (
          <p className="text-center text-ink-muted">{copy.verify.resendExhausted}</p>
        ) : (
          <>
            <LinkButton onClick={() => void onResend()} disabled={busy || resend.kind === "wait"}>
              {copy.verify.resend}
            </LinkButton>
            {resend.kind === "wait" ? <p className="text-ink-muted">{copy.verify.resendIn(resend.seconds)}</p> : null}
          </>
        )}
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>
        <LinkButton onClick={backToSignup}>{copy.verify.changeEmail}</LinkButton>
      </div>
    </form>
  );
}

function MissingSignup() {
  const { lang, copy } = useAuthLang();
  return (
    <div className="space-y-5">
      <StepHeading title={copy.verify.title} />
      <ErrorNote>{copy.verify.missing}</ErrorNote>
      <a href={hrefWithLang(SIGNUP_PATH, lang)} className="inline-flex min-h-11 items-center font-semibold text-signal-ink underline underline-offset-4">
        {copy.verify.restart}
      </a>
    </div>
  );
}

export function VerifyView() {
  const [pending] = useState(readPendingSignup);
  return (
    <AuthLangProvider title="verify">
      <AuthLayout>{pending ? <VerifyScreen initial={pending} /> : <MissingSignup />}</AuthLayout>
    </AuthLangProvider>
  );
}

/** Where a WAF reload of /signup goes back to, when it was asked from this screen. */
export function resumeTarget(search: URLSearchParams): string | undefined {
  if (search.get(RESUME_PARAM) !== RESUME_VERIFY || readPendingSignup() === undefined) return undefined;
  const next = new URLSearchParams(search);
  next.delete(RESUME_PARAM);
  return `${SIGNUP_VERIFY_PATH}?${next.toString()}`;
}
