// A signed-in broker or analyst changes its own password in place (lib/auth/password-change.ts):
// the current password, the new one against the pool's policy, and Cognito's answer. A guest never
// gets here (SecurityPrompts refuses the prompt and the header hides the option).
import { useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { useSession } from "../../context/SessionContext";
import type { AuthFlowErrorCode } from "../../lib/auth/errors";
import { changeOwnPassword } from "../../lib/auth/password-change";
import { useAuthCopy } from "./AuthLang";
import type { AuthCopy } from "./copy";
import { ErrorNote, NoticeNote, PasswordField, SubmitButton } from "./form-parts";
import { useNewPassword } from "./steps";

function errorText(copy: AuthCopy, error: AuthFlowErrorCode): string {
  return error === "INVALID_CREDENTIALS" ? copy.prompts.changePassword.wrongCurrent : copy.flowErrors[error];
}

export function ChangePasswordForm({ onClose }: { readonly onClose: () => void }) {
  const copy = useAuthCopy();
  const texts = copy.prompts.changePassword;
  const { state, auth } = useSession();
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFlowErrorCode | undefined>(undefined);
  const [done, setDone] = useState(false);
  const form = useNewPassword();

  if (done) {
    return (
      <div className="space-y-4">
        <NoticeNote>{texts.done}</NoticeNote>
        <Button onClick={onClose}>{copy.prompts.close}</Button>
      </div>
    );
  }
  if (state.status !== "authenticated" || !auth) return <ErrorNote>{copy.flowErrors.UNAVAILABLE}</ErrorNote>;
  const session = { tokens: state.tokens, isGuest: state.principal.isGuest };
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
      <p className="text-sm text-ink-muted">{texts.lead}</p>
      {error ? <ErrorNote>{errorText(copy, error)}</ErrorNote> : null}
      <PasswordField label={texts.current} autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required />
      {form.fields(texts.field)}
      {same ? <p className="text-xs text-danger">{texts.same}</p> : null}
      <SubmitButton busy={busy}>{texts.submit}</SubmitButton>
    </form>
  );
}
