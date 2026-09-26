// Small pieces the clock view's sections share (and the guided tour reuses): the outcome of the last
// command, the note that says why the time controls are closed, and a date-time field read as
// Argentina's wall clock. Failures go through ApiErrorNotice, so `WORLD_BUSY`, an old sign-in or a
// role refusal read the same everywhere.
import { useId } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Callout } from "../../components/Callout";
import { FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "../../components/form-classes";
import type { ActionState } from "../../lib/use-remote";
import type { ControlGate } from "./clock-model";

export function ActionOutcome<T>({ state, done }: { readonly state: ActionState<T>; readonly done: string }) {
  if (state.status === "error") return <ApiErrorNotice error={state.error} />;
  if (state.status === "done") return <Callout tone="success" title={done} />;
  return null;
}

/** Why the controls are closed (or open only with "Avanzar igual"); nothing when they are open. */
export function GateNote({ id, gate }: { readonly id: string; readonly gate: ControlGate }) {
  if (gate.reason === undefined) return null;
  return (
    <p id={id} role="status" className={`rounded-md px-3 py-2 text-sm ${gate.force ? "bg-warning-soft text-warning" : "bg-info-soft text-info"}`}>
      {gate.reason}
    </p>
  );
}

interface DateTimeFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly disabled?: boolean;
}

/** `<input type="datetime-local">`; the caller reads it as Argentina's wall time (lib/local-datetime.ts). */
export function DateTimeField({ label, value, onChange, hint, disabled }: DateTimeFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <label htmlFor={id} className={LABEL_CLASS}>
      {label}
      <input
        id={id}
        type="datetime-local"
        className={FIELD_CLASS}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <span id={hintId} className={HINT_CLASS}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}
