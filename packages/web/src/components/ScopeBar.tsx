// What a data view is about: the firm of the session (from the token, named by `account.session`;
// the user never picks another) and, where the view lists operations, the range of ETA it shows.
// The range lives in FirmContext so it survives moving between views; the inputs are plain dates
// (`YYYY-MM-DD`) so a test or a capture can set them by value.
import { useId } from "react";
import { type EtaRange, useFirm } from "../context/FirmContext";
import { copy } from "../copy/console";
import { Button } from "./Button";
import { FIELD_CLASS, LABEL_CLASS } from "./form-classes";

function DateInput({ label, value, max, min, onChange }: { readonly label: string; readonly value: string | undefined; readonly min?: string; readonly max?: string; readonly onChange: (value: string | undefined) => void }) {
  const id = useId();
  return (
    <label htmlFor={id} className={LABEL_CLASS}>
      {label}
      <input
        id={id}
        type="date"
        className={FIELD_CLASS}
        value={value ?? ""}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
      />
    </label>
  );
}

function withEnd(range: EtaRange, end: keyof EtaRange, value: string | undefined): EtaRange {
  const next: { from?: string; to?: string } = { ...range };
  if (value === undefined) delete next[end];
  else next[end] = value;
  return next;
}

export function ScopeBar({ etaRange = false }: { readonly etaRange?: boolean }) {
  const { firmName, etaRange: range, setEtaRange } = useFirm();
  return (
    <section aria-label={copy.scope.label} className="mb-6 flex flex-wrap items-end gap-4 rounded-card border border-mist bg-white px-4 py-3 shadow-card">
      {firmName ? (
        <p className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate">
          {copy.app.firmLabel}
          <span className="py-2 text-sm font-semibold normal-case tracking-normal text-navy">{firmName}</span>
        </p>
      ) : null}
      {etaRange ? (
        <>
          <DateInput label={copy.scope.etaFrom} value={range.from} {...(range.to !== undefined ? { max: range.to } : {})} onChange={(value) => setEtaRange(withEnd(range, "from", value))} />
          <DateInput label={copy.scope.etaTo} value={range.to} {...(range.from !== undefined ? { min: range.from } : {})} onChange={(value) => setEtaRange(withEnd(range, "to", value))} />
          <Button variant="ghost" disabled={range.from === undefined && range.to === undefined} onClick={() => setEtaRange({})}>
            {copy.scope.clear}
          </Button>
        </>
      ) : null}
    </section>
  );
}
