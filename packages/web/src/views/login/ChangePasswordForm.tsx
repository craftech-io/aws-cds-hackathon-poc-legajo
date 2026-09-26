// A signed-in broker or analyst changes its own password in place (lib/auth/password-change.ts):
// the current password, the new one against the pool's policy, and Cognito's answer. A judge never
// gets here (SecurityPrompts refuses the prompt and the header hides the option).
import { useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { useSession } from "../../context/SessionContext";
import type { AuthFlowErrorCode } from "../../lib/auth/errors";
import { changeOwnPassword } from "../../lib/auth/password-change";
import { loginCopy } from "./copy";
import { ErrorNote, NoticeNote, PasswordField, SubmitButton } from "./form-parts";
import { useNewPassword } from "./steps";

function errorText(error: AuthFlowErrorCode): string {
  return error === "INVALID_CREDENTIALS" ? loginCopy.changePassword.wrongCurrent : loginCopy.errors[error];
}

export function ChangePasswordForm({ onClose }: { readonly onClose: () => void }) {
  const { state, auth } = useSession();
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFlowErrorCode | undefined>(undefined);
  const [done, setDone] = useState(false);
  const form = useNewPassword();

  if (done) {
    return (
      <div className="space-y-4">
        <NoticeNote>{loginCopy.changePassword.done}</NoticeNote>
        <Button onClick={onClose}>{loginCopy.close}</Button>
      </div>
    );
  }
  if (state.status !== "authenticated" || !auth) return <ErrorNote>{loginCopy.errors.UNAVAILABLE}</ErrorNote>;
  const session = { tokens: state.tokens, isJudge: state.principal.isJudge };
  const same = form.password.length > 0 && form.password === current;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !form.valid || same || !current) return;
    setBusy(true);
    void changeOwnPassword(auth.cognito, session, { current, proposed: form.password })
      .then((result) => {
        if (result.ok) setDone(true);
        else setError(result.error);
      })
      .finally(() => {
        setBusy(false);
        setCurrent("");
        form.reset();
      });
  };

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <p className="text-sm text-slate">{loginCopy.changePassword.lead}</p>
      {error ? <ErrorNote>{errorText(error)}</ErrorNote> : null}
      <PasswordField label={loginCopy.changePassword.current} autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required />
      {form.fields(loginCopy.changePassword.field)}
      {same ? <p className="text-xs text-danger">{loginCopy.changePassword.same}</p> : null}
      <SubmitButton busy={busy}>{loginCopy.changePassword.submit}</SubmitButton>
    </form>
  );
}
