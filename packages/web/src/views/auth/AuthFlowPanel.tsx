// The sign-in machine on screen: one step component per state, the error of the last step and the
// way back to the start. Used by `/login` and by the console's step-up drawer.
import { Suspense, lazy, type ReactNode } from "react";
import { useAuthCopy } from "./AuthLang";
import { ErrorNote, LinkButton } from "./form-parts";
import { CredentialsStep, NewPasswordStep, TotpStep } from "./steps";
import type { AuthFlowHandle } from "./use-auth-flow";

// TOTP enrolment (and its QR drawing) is for staff only: a visitor of the public pages never loads it.
const MfaSetupStep = lazy(() => import("./MfaSetupStep").then((module) => ({ default: module.MfaSetupStep })));

interface AuthFlowPanelProps {
  readonly flow: AuthFlowHandle;
  /** Step-up: the sign-in name is the session's and cannot change. */
  readonly fixedLogin?: string;
  /** Pre-filled sign-in name (after a verification or a reset). */
  readonly initialLogin?: string;
  readonly inDrawer?: boolean;
  /** Shown above the credentials when nothing else is (e.g. "the session expired"). */
  readonly credentialsNotice?: string;
  /** Under the credentials form: "Olvidé mi contraseña" and "Probá la demo" on `/login`. */
  readonly credentialsFooter?: ReactNode;
}

export function AuthFlowPanel({ flow, fixedLogin, initialLogin, inDrawer = false, credentialsNotice, credentialsFooter }: AuthFlowPanelProps) {
  const copy = useAuthCopy();
  const { state, error, busy, dispatch } = flow;
  const common = { busy, dispatch, inDrawer };
  const restart = <LinkButton onClick={() => dispatch({ type: "restart" })}>{state.step === "totp" ? copy.steps.otherUser : copy.steps.back}</LinkButton>;

  let body;
  switch (state.step) {
    case "credentials": {
      const notice = state.notice === "passwordReset" ? copy.login.notices.reset : credentialsNotice;
      body = (
        <CredentialsStep
          {...common}
          {...(fixedLogin !== undefined ? { fixedLogin } : {})}
          {...(initialLogin !== undefined ? { initialLogin } : {})}
          {...(notice !== undefined ? { notice } : {})}
          {...(credentialsFooter !== undefined ? { footer: credentialsFooter } : {})}
        />
      );
      break;
    }
    case "newPassword":
      body = <NewPasswordStep {...common} />;
      break;
    case "totp":
      body = <TotpStep {...common} />;
      break;
    case "mfaSetup":
      body = (
        <Suspense fallback={<p className="text-sm">{copy.steps.working}</p>}>
          <MfaSetupStep {...common} setup={state.setup} />
        </Suspense>
      );
      break;
    case "forgotRequest":
    case "forgotConfirm":
    case "done":
      // Recovery has its own screens (/forgot, /forgot/reset); a finished sign-in leaves this panel.
      body = null;
      break;
  }

  // The same step component can come back with a fresh state (a new challenge): re-mount it.
  const key = state.step === "credentials" ? `credentials-${state.notice ?? ""}` : state.step;
  return (
    <div className="space-y-4">
      {error && error !== "UNCONFIRMED" ? <ErrorNote>{copy.flowErrors[error]}</ErrorNote> : null}
      <div key={key}>{body}</div>
      {state.step !== "credentials" && state.step !== "done" && !(inDrawer && state.step === "mfaSetup") ? <div className="text-center">{restart}</div> : null}
    </div>
  );
}
