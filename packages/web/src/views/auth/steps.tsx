// One component per state of the sign-in machine. They hold what the person types (in memory,
// cleared when the step changes) and hand it to `dispatch`; the machine decides what comes next.
// Recovery has its own screens (ForgotView), so these are the credentials, the first password of an
// invited account and the TOTP code.
import { useState, type FormEvent, type ReactNode } from "react";
import { hasOuterSpaces, looksLikeSignInName, missingPasswordRules } from "../../lib/auth/credentials";
import type { AuthFlowAction } from "../../lib/auth/flow";
import { useAuthCopy } from "./AuthLang";
import { CodeField, Field, NoticeNote, PasswordField, PasswordRules, StepHeading, SubmitButton } from "./form-parts";

export interface StepProps {
  readonly busy: boolean;
  readonly dispatch: (action: AuthFlowAction) => void;
  readonly inDrawer?: boolean;
}

function submit(handler: () => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handler();
  };
}

interface CredentialsStepProps extends StepProps {
  /** Step-up: the sign-in name of the session, shown and not editable. */
  readonly fixedLogin?: string;
  readonly initialLogin?: string;
  readonly notice?: string;
  readonly footer?: ReactNode;
}

/** Email of the account (or of the invitation), or the username of a reserved guest account. */
export function CredentialsStep({ busy, dispatch, inDrawer, fixedLogin, initialLogin, notice, footer }: CredentialsStepProps) {
  const copy = useAuthCopy();
  const [login, setLogin] = useState(fixedLogin ?? initialLogin ?? "");
  const [password, setPassword] = useState("");
  const onSubmit = submit(() => {
    if (!looksLikeSignInName(login) || !password) return;
    dispatch({ type: "signIn", login, password });
    setPassword("");
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      {inDrawer ? null : <StepHeading title={copy.login.title} lead={copy.login.lead} />}
      {notice ? <NoticeNote>{notice}</NoticeNote> : null}
      <Field
        label={copy.login.login}
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={login}
        onChange={(event) => setLogin(event.target.value)}
        readOnly={fixedLogin !== undefined}
        required
      />
      <PasswordField label={copy.login.password} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      <SubmitButton busy={busy} busyLabel={copy.login.submitting}>
        {copy.login.submit}
      </SubmitButton>
      {footer}
    </form>
  );
}

/** New password + confirmation, checked against the pool's policy before anything is sent. */
export function useNewPassword() {
  const copy = useAuthCopy();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = missingPasswordRules(password).length === 0 && !hasOuterSpaces(password) && password === confirm;
  const reset = () => {
    setPassword("");
    setConfirm("");
  };
  const fields = (label: string) => (
    <>
      <PasswordField label={label} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      <PasswordRules password={password} />
      <PasswordField label={copy.password.confirm} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
      {mismatch ? <p className="text-sm text-danger">{copy.password.mismatch}</p> : null}
      {hasOuterSpaces(password) ? <p className="text-sm text-danger">{copy.password.outerSpaces}</p> : null}
    </>
  );
  return { password, valid, reset, fields };
}

export function NewPasswordStep({ busy, dispatch, inDrawer }: StepProps) {
  const copy = useAuthCopy();
  const form = useNewPassword();
  const onSubmit = submit(() => {
    if (!form.valid) return;
    dispatch({ type: "newPassword", password: form.password });
    form.reset();
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={copy.steps.newPassword.title} lead={copy.steps.newPassword.lead} inDrawer={inDrawer} />
      {form.fields(copy.steps.newPassword.field)}
      <SubmitButton busy={busy}>{copy.steps.newPassword.submit}</SubmitButton>
    </form>
  );
}

export function TotpStep({ busy, dispatch, inDrawer }: StepProps) {
  const copy = useAuthCopy();
  const [code, setCode] = useState("");
  const onSubmit = submit(() => {
    dispatch({ type: "totp", code });
    setCode("");
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={copy.steps.totp.title} lead={copy.steps.totp.lead} inDrawer={inDrawer} />
      <CodeField label={copy.steps.totp.code} value={code} onChange={setCode} />
      <SubmitButton busy={busy}>{copy.steps.totp.submit}</SubmitButton>
    </form>
  );
}
