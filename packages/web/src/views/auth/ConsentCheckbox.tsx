// One consent box of the sign-up (ADR-0015 §2, FL-119): unticked until the person ticks it, its words
// from packages/shared/src/consent-texts.ts (the only source, with its version), the legal pages it
// names opened in a new tab so the form is not lost, and its hint and error read with the box.
import { CONSENT_REQUIRED, type ConsentKind, SIGNUP_CONSENT_TEXTS, legalPageHref } from "@legajo/shared/consent-texts";
import { useAuthLang } from "./AuthLang";

interface ConsentCheckboxProps {
  readonly id: string;
  readonly kind: ConsentKind;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly onBlur?: () => void;
  readonly hint?: string;
  readonly error?: string;
}

export function ConsentCheckbox({ id, kind, checked, onChange, onBlur, hint, error }: ConsentCheckboxProps) {
  const { lang, copy } = useAuthLang();
  const described = [hint ? `${id}-hint` : undefined, error ? `${id}-error` : undefined].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          onBlur={onBlur}
          required={CONSENT_REQUIRED[kind]}
          aria-invalid={error ? true : undefined}
          aria-describedby={described || undefined}
          className="mt-3 h-6 w-6 shrink-0 accent-harbor-950"
        />
        <label htmlFor={id} className="block min-h-11 py-2.5 text-sm leading-6 text-ink">
          {SIGNUP_CONSENT_TEXTS[kind][lang].map((run, index) =>
            run.link ? (
              <a key={index} href={legalPageHref(run.link, lang)} target="_blank" rel="noopener noreferrer" className="font-semibold text-signal-ink underline underline-offset-2">
                {run.text}
                <span className="sr-only"> {copy.layout.newTab}</span>
              </a>
            ) : (
              <span key={index}>{run.text}</span>
            ),
          )}
        </label>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="pl-9 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="pl-9 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
