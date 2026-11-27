// `/verify-phone` (ADR-0021): the SMS code of every sign-in session, in its own chunk (app.tsx loads it
// lazily, never with the landing). It asks `account.phoneStatus` first: a session that already passed
// goes on at once; an account without a verified number enrols (the sign-up's number prefilled and
// editable); one with a number gets the code there, shown only by its last four digits, and cannot change
// it. Then the six digits, the resend with its countdown and a clear message for every refusal, with
// Craftech's contact where only a person can help. The rules live in phone-model.ts.
import { PHONE_CODE } from "@legajo/shared/guest-limits";
import { PHONE_DIGITS } from "@legajo/shared/phone-verification";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSession } from "../../context/SessionContext";
import { Redirect, useRouter } from "../../lib/router";
import { LOGIN_PATH } from "../../routes";
import { AuthLangProvider, useAuthLang } from "../auth/AuthLang";
import { AuthLayout } from "../auth/AuthLayout";
import { CodeField, ErrorNote, Field, LinkButton, NoticeNote, StepHeading, SubmitButton } from "../auth/form-parts";
import { EXTERNAL_LINK, contactHref } from "../landing/links";
import { PHONE_COPY, type PhoneCopy } from "./copy";
import { fetchPhoneStatus, sendPhoneCode, verifyPhoneCode } from "./phone-api";
import { type PhoneNotice, failureNotice, isValidCode, offersContact, phoneProblem, returnTarget, secondsUntil, sendOutcome, verifyOutcome } from "./phone-model";

type Mode = { readonly kind: "loading" } | { readonly kind: "enrol"; readonly phone: string } | { readonly kind: "signIn"; readonly hint: string };

function noticeText(copy: PhoneCopy, notice: PhoneNotice): string {
  switch (notice.kind) {
    case "sent":
      return copy.sent(notice.hint, PHONE_CODE.ttlSeconds / 60);
    case "limit":
      return copy.errors.limit(notice.limit, notice.minutes);
    case "inUse":
      return copy.errors.inUse;
    case "locked":
      return copy.phoneLocked;
    case "sendFailed":
      return copy.errors.sendFailed;
    case "invalid":
      return copy.errors.invalid(notice.attemptsLeft);
    case "expired":
      return copy.errors.expired;
    case "phoneRequired":
      return copy.errors.phone(PHONE_DIGITS.min, PHONE_DIGITS.max);
    case "notPersonal":
      return copy.errors.notPersonal;
    case "blocked":
      return copy.errors.blocked;
    case "countryNotAllowed":
      return copy.errors.countryNotAllowed;
    case "generic":
      return copy.errors.generic;
  }
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function ContactLink({ label }: { readonly label: string }) {
  return (
    <a href={contactHref("phone")} {...EXTERNAL_LINK} className="inline-flex min-h-11 items-center text-sm font-semibold text-signal-ink underline underline-offset-4">
      {label}
    </a>
  );
}

function PhoneScreen() {
  const { lang } = useAuthLang();
  const copy = PHONE_COPY[lang];
  const { trpc, signOut } = useSession();
  const { search, navigate } = useRouter();
  const target = returnTarget(search);
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sentOnce, setSentOnce] = useState(false);
  const [resendAt, setResendAt] = useState<number | undefined>(undefined);
  const [notice, setNotice] = useState<PhoneNotice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const asked = useRef(false);
  const now = useNow(1_000);

  const send = async (typed?: string) => {
    setBusy(true);
    try {
      const outcome = sendOutcome(await sendPhoneCode(trpc, typed), Date.now());
      if (outcome.kind === "cleared") return navigate(target, { replace: true });
      if (outcome.kind === "sent") {
        setSentOnce(true);
        setResendAt(outcome.resendAt);
        setNotice({ kind: "sent", hint: outcome.hint });
        return;
      }
      if (outcome.resendAt !== undefined) setResendAt(outcome.resendAt);
      setNotice(outcome.notice);
    } catch (error) {
      setNotice(failureNotice(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    fetchPhoneStatus(trpc)
      .then((status) => {
        if (!active) return;
        if (status.status === "CLEARED") return navigate(target, { replace: true });
        if (status.status === "ENROL") {
          setPhone(status.phone ?? "");
          return setMode({ kind: "enrol", phone: status.phone ?? "" });
        }
        setMode({ kind: "signIn", hint: status.hint });
        // A sign-in with a verified number: the code goes out on arrival, once per visit.
        if (!asked.current) {
          asked.current = true;
          void send();
        }
      })
      .catch((error: unknown) => active && setNotice(failureNotice(error)));
    return () => {
      active = false;
    };
    // One status read per visit.
  }, [trpc]);

  const onSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const problem = mode.kind === "enrol" ? phoneProblem(phone) : undefined;
    if (problem !== undefined) return setNotice(problem);
    void send(mode.kind === "enrol" ? phone : undefined);
  };

  const onVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (busy || !isValidCode(code)) return;
    setBusy(true);
    try {
      const outcome = verifyOutcome(await verifyPhoneCode(trpc, code));
      if (outcome.kind === "cleared") return navigate(target, { replace: true });
      setCode("");
      setNotice(outcome.notice);
    } catch (error) {
      setNotice(failureNotice(error));
    } finally {
      setBusy(false);
    }
  };

  // A blocked account (ADR-0021 §16) gets nothing but the notice, Craftech's contact and the way out.
  if (notice?.kind === "blocked")
    return (
      <div className="space-y-5">
        <ErrorNote>{noticeText(copy, notice)}</ErrorNote>
        <ContactLink label={copy.contact} />
        <p className="text-center text-sm">
          <LinkButton onClick={signOut}>{copy.signOut}</LinkButton>
        </p>
      </div>
    );
  if (mode.kind === "loading") return notice ? <ErrorNote>{noticeText(copy, notice)}</ErrorNote> : <p className="text-sm text-ink-muted">{copy.checking}</p>;
  const wait = secondsUntil(resendAt, now);
  const isError = notice !== undefined && notice.kind !== "sent";
  return (
    <div className="space-y-5">
      <StepHeading title={mode.kind === "enrol" ? copy.enrolTitle : copy.signInTitle} lead={mode.kind === "enrol" ? copy.enrolLead : copy.signInLead(mode.hint)} />
      {notice ? isError ? <ErrorNote>{noticeText(copy, notice)}</ErrorNote> : <NoticeNote>{noticeText(copy, notice)}</NoticeNote> : null}
      {offersContact(notice) ? <ContactLink label={copy.contact} /> : null}
      {mode.kind === "enrol" && !sentOnce ? (
        <form className="space-y-4" onSubmit={onSend} noValidate>
          <Field id="phone-number" label={copy.phone} hint={copy.phoneHint} type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} required />
          <SubmitButton busy={busy} busyLabel={copy.sending}>
            {copy.send}
          </SubmitButton>
        </form>
      ) : (
        <form className="space-y-4" onSubmit={(event) => void onVerify(event)} noValidate>
          <CodeField label={copy.code} value={code} onChange={setCode} {...(submitted && !isValidCode(code) ? { error: copy.errors.code(PHONE_CODE.digits) } : {})} />
          <SubmitButton busy={busy} busyLabel={copy.verifying}>
            {copy.verify}
          </SubmitButton>
          <div className="text-sm">
            {wait > 0 ? (
              <p className="text-ink-muted">{copy.resendIn(wait)}</p>
            ) : (
              <LinkButton onClick={() => void send(mode.kind === "enrol" ? phone : undefined)} disabled={busy}>
                {copy.resend}
              </LinkButton>
            )}
          </div>
        </form>
      )}
      <p className="text-center text-sm">
        <LinkButton onClick={signOut}>{copy.signOut}</LinkButton>
      </p>
    </div>
  );
}

export function PhoneView() {
  const { state } = useSession();
  const { search } = useRouter();
  if (state.status === "anonymous" || state.status === "unconfigured") return <Redirect to={`${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTarget(search))}`} />;
  return (
    <AuthLangProvider title="phone">
      <AuthLayout>{state.status === "loading" ? null : <PhoneScreen />}</AuthLayout>
    </AuthLangProvider>
  );
}
