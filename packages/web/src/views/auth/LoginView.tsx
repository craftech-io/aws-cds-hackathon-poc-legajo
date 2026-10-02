// `/login` (docs/landing-spec.md §8.4, FL-079, FL-106): the email of the account or the username of a
// reserved guest account, by SRP (lib/auth/flow.ts; the password never leaves the browser). One
// message for an unknown user and a wrong password. A right password on an email that was never
// verified goes back to the code of that sign-up (with a resend, when this tab still has it) or to the
// form; the browser never calls `ResendConfirmationCode` itself. Staff keep their first password and
// optional TOTP; a guest never sees either. A guest without a world goes to `/welcome`.
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/SessionContext";
import { flowDeps } from "../../lib/auth/deps";
import { safeReturnTo } from "../../lib/auth/tokens";
import { Link, Redirect, useRouter } from "../../lib/router";
import { saveChallengeDraft } from "../../lib/waf";
import { CONSOLE_HOME, FORGOT_PATH, LOGIN_PATH, SIGNUP_PATH, SIGNUP_VERIFY_PATH } from "../../routes";
import { AuthFlowPanel } from "./AuthFlowPanel";
import { AuthLangProvider, useAuthLang } from "./AuthLang";
import { AuthLayout } from "./AuthLayout";
import { readPendingSignup, savePendingSignup, takeLoginEmail } from "./handoff";
import { hrefWithLang } from "./lang";
import { NOTICE_PARAM, UNCONFIRMED_NOTICE, destinationAfterSignIn } from "./session";
import { resendCode } from "./signup-api";
import { draftOfFields } from "./signup-model";
import { StepHeading } from "./form-parts";
import { useAuthFlow } from "./use-auth-flow";
import { resendOutcome } from "./verify-model";

/** A build without the pool's variables: says which are missing instead of offering a sign-in that cannot work. */
function Unconfigured({ missing }: { readonly missing: readonly string[] }) {
  const { copy } = useAuthLang();
  return (
    <div className="space-y-3">
      <StepHeading title={copy.login.unconfiguredTitle} lead={copy.login.unconfiguredLead} />
      <ul className="list-disc pl-5 font-mono text-xs text-danger">
        {missing.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </div>
  );
}

function LoginScreen() {
  const { lang, copy } = useAuthLang();
  const { state, auth, trpc, completeSignIn } = useSession();
  const { search, navigate } = useRouter();
  const returnTo = safeReturnTo(search.get("returnTo"), LOGIN_PATH, CONSOLE_HOME);
  const [initialLogin] = useState(takeLoginEmail);
  const deps = useMemo(() => (auth ? flowDeps(auth.cognito, auth.srp, { kind: "signIn" }) : undefined), [auth]);
  const flow = useAuthFlow(deps, (done) => completeSignIn(done.tokens));
  const unconfirmed = flow.state.step === "credentials" ? flow.state.unconfirmed : undefined;

  useEffect(() => {
    if (!unconfirmed) return;
    const pending = readPendingSignup();
    const notice = new URLSearchParams({ [NOTICE_PARAM]: UNCONFIRMED_NOTICE });
    if (!pending || pending.email !== unconfirmed) {
      // Another device, or a sign-up this tab no longer holds: a new `signup.start` replaces the user.
      saveChallengeDraft(draftOfFields({ email: unconfirmed }));
      window.location.assign(hrefWithLang(SIGNUP_PATH, lang, notice));
      return;
    }
    void resendCode(trpc, pending.signupId)
      .then((answer) => {
        const outcome = resendOutcome(answer, Date.now());
        if (outcome.kind === "sent") savePendingSignup({ ...pending, resends: pending.resends + 1, resendAvailableAt: outcome.availableAt });
      })
      .catch(() => undefined)
      .finally(() => navigate(hrefWithLang(SIGNUP_VERIFY_PATH, lang, notice)));
  }, [unconfirmed, lang, navigate, trpc]);

  if (state.status === "authenticated") return <Redirect to={destinationAfterSignIn(state.principal, returnTo)} />;
  if (state.status === "unconfigured") return <Unconfigured missing={state.missing} />;
  if (state.status === "loading") return <p className="text-sm text-ink-muted">{copy.steps.working}</p>;

  let notice: string | undefined;
  if (state.reason === "expired") notice = copy.login.notices.sessionExpired;
  else if (search.get("reset") === "1") notice = copy.login.notices.reset;
  else if (search.get("welcome") === "1") notice = copy.login.notices.welcome;

  const footer = (
    <div className="flex flex-col items-center gap-1 pt-1 text-sm">
      <Link to={hrefWithLang(FORGOT_PATH, lang)} className="inline-flex min-h-11 items-center font-semibold text-signal-ink underline-offset-4 hover:underline">
        {copy.login.forgot}
      </Link>
      {/* A full page load, never the router: WAF challenges the /signup document (ADR-0015 §3.3). */}
      <a href={hrefWithLang(SIGNUP_PATH, lang)} className="inline-flex min-h-11 items-center font-semibold text-signal-ink underline-offset-4 hover:underline">
        {copy.login.noAccount}
      </a>
    </div>
  );
  return (
    <AuthFlowPanel
      flow={flow}
      credentialsFooter={footer}
      {...(initialLogin !== undefined ? { initialLogin } : {})}
      {...(notice !== undefined ? { credentialsNotice: notice } : {})}
    />
  );
}

export function LoginView() {
  return (
    <AuthLangProvider title="login">
      <AuthLayout>
        <LoginScreen />
      </AuthLayout>
    </AuthLangProvider>
  );
}
