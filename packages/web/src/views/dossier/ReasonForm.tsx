// A decision of the firm that carries its reason: dispensing an observation, reopening a dossier,
// resolving an escalation. One required text, one button, the refusal of the BFF in words. The reason
// travels to the audit log with the user behind the session.
import { type FormEvent, useId, useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { ERROR_CLASS, FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "../../components/form-classes";
import type { ApiError } from "../../lib/api-error";

/** The BFF keeps at most 500 characters of a reason or a resolution. */
const REASON_MAX = 500;

interface ReasonFormProps {
  readonly label: string;
  readonly hint?: string;
  readonly submit: string;
  readonly working: string;
  readonly running: boolean;
  readonly error: ApiError | undefined;
  readonly requiredText: string;
  readonly onSubmit: (reason: string) => void;
}

export function ReasonForm({ label, hint, submit, working, running, error, requiredText, onSubmit }: ReasonFormProps) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const trimmed = reason.trim();
  const missing = touched && trimmed === "";

  const send = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (trimmed !== "") onSubmit(trimmed);
  };

  return (
    <form className="space-y-4" onSubmit={send} noValidate>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
        <textarea
          id={id}
          rows={4}
          maxLength={REASON_MAX}
          className={FIELD_CLASS}
          value={reason}
          aria-invalid={missing ? true : undefined}
          onChange={(event) => setReason(event.target.value)}
        />
        {hint ? <span className={HINT_CLASS}>{hint}</span> : null}
        {missing ? <span className={ERROR_CLASS}>{requiredText}</span> : null}
      </label>
      {error ? <ApiErrorNotice error={error} /> : null}
      <Button type="submit" disabled={running}>
        {running ? working : submit}
      </Button>
    </form>
  );
}
