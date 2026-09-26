// Pieces of the registry's forms: labelled text fields with their hint and error, the footer with
// save and cancel, the refusal of a change in the firm's words (the fence, a duplicated phone or email)
// and the hook that runs one change at a time and reloads the lists when it lands.
import { useId, type ReactNode } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { ERROR_CLASS, FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { useSession } from "../../context/SessionContext";
import { type Action, type ActionState, useAction } from "../../lib/use-remote";
import { registryCopy } from "./copy";
import { type RegistryChange, runRegistryChange } from "./registry-api";
import { registryErrorText } from "./registry-model";

interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string;
  readonly type?: "text" | "tel" | "email";
  readonly multiline?: boolean;
  readonly autoComplete?: string;
}

export function TextField({ label, value, onChange, hint, error, type = "text", multiline = false, autoComplete = "off" }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : undefined, error ? `${id}-error` : undefined].filter(Boolean).join(" ") || undefined;
  const common = { id, value, className: FIELD_CLASS, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, autoComplete };
  return (
    <label htmlFor={id} className={LABEL_CLASS}>
      {label}
      {multiline ? <textarea {...common} rows={3} onChange={(event) => onChange(event.target.value)} /> : <input {...common} type={type} onChange={(event) => onChange(event.target.value)} />}
      {hint ? (
        <span id={`${id}-hint`} className={HINT_CLASS}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className={ERROR_CLASS}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

/** A refused change: the session prompts keep ApiErrorNotice; the rest reads in the registry's words. */
export function ChangeOutcome({ state, done }: { readonly state: ActionState<unknown>; readonly done: string }) {
  if (state.status === "done") return <Callout tone="success" title={done} />;
  if (state.status !== "error") return null;
  const { error } = state;
  if (error.kind === "recentLogin" || error.kind === "unauthorized" || error.kind === "network" || error.kind === "unavailable") return <ApiErrorNotice error={error} />;
  return <Callout tone="danger" title={registryErrorText(error)} />;
}

interface FormFooterProps {
  readonly submit: string;
  readonly disabled: boolean;
  readonly onCancel: () => void;
}

export function FormFooter({ submit, disabled, onCancel }: FormFooterProps) {
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      <Button type="submit" disabled={disabled}>
        {submit}
      </Button>
      <Button variant="secondary" onClick={onCancel}>
        {registryCopy.forms.cancel}
      </Button>
    </div>
  );
}

export function FormBody({ onSubmit, children }: { readonly onSubmit: () => void; readonly children: ReactNode }) {
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** One registry change at a time; `onSaved` runs after it lands (reload the lists). */
export function useRegistryChange(onSaved: () => void): Action<RegistryChange, unknown> {
  const { trpc } = useSession();
  return useAction(async (change: RegistryChange) => {
    const result = await runRegistryChange(trpc, change);
    onSaved();
    return result;
  });
}
