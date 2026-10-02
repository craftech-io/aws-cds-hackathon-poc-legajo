// Form controls of the access screens (docs/landing-spec.md §3.7, §5.2): a visible label tied to its
// input, the hint and the error read through `aria-describedby`, `aria-invalid` on a field in error,
// the autocomplete hints password managers need, and inputs of at least 16 px so iOS does not zoom.
// Nothing here stores a value.
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { missingPasswordRules, type PasswordRule } from "../../lib/auth/credentials";
import { PASSWORD_POLICY } from "@legajo/shared/password-policy";
import { useAuthLang } from "./AuthLang";
import { CODE_DIGITS } from "./copy";

/** 16 px text so iOS never zooms into a field; the error border replaces the rule colour. */
const INPUT_CLASS = "min-h-11 w-full rounded-card border bg-white px-3 py-2.5 text-base text-ink placeholder:text-ink-muted read-only:bg-manifest";

// The same controls inside the console (step-up, TOTP, password change) keep the console's palette.
const SURFACE = {
  public: {
    submit: "rounded-pill bg-harbor-950 text-foam hover:bg-harbor-800",
    link: "text-signal-ink",
    notice: "bg-manifest-deep text-ink",
    rules: "bg-manifest text-ink-muted",
    met: "text-glass-ink",
    heading: "font-display text-h3 font-semibold text-ink",
  },
  console: {
    submit: "rounded-md bg-navy text-white hover:bg-navy-soft",
    link: "text-cyan-deep",
    notice: "bg-success-soft text-success",
    rules: "bg-paper text-slate",
    met: "text-success",
    heading: "text-2xl font-semibold text-navy",
  },
} as const;

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly trailing?: ReactNode;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint, error, trailing, id: givenId, ...input }, ref) {
  const autoId = useId();
  const id = givenId ?? autoId;
  const described = [hint ? `${id}-hint` : undefined, error ? `${id}-error` : undefined].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={described || undefined}
          className={`${INPUT_CLASS} ${trailing ? "pr-24" : ""} ${error ? "border-danger" : "border-rule"}`}
          {...input}
        />
        {trailing ? <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div> : null}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export const PasswordField = forwardRef<HTMLInputElement, Omit<FieldProps, "type" | "trailing">>(function PasswordField(props, ref) {
  const { copy, surface } = useAuthLang();
  const [visible, setVisible] = useState(false);
  return (
    <Field
      {...props}
      ref={ref}
      type={visible ? "text" : "password"}
      spellCheck={false}
      autoCapitalize="none"
      trailing={
        <button
          type="button"
          className={`min-h-11 rounded-md px-3 text-sm font-semibold hover:bg-manifest ${SURFACE[surface].link}`}
          onClick={() => setVisible((shown) => !shown)}
          aria-pressed={visible}
        >
          {visible ? copy.password.hide : copy.password.show}
        </button>
      }
    />
  );
});

/** One input for the whole code (pasting it works), digits only. */
export function CodeField({ label, value, onChange, error }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly error?: string }) {
  return (
    <Field
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, CODE_DIGITS))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      required
      {...(error !== undefined ? { error } : {})}
    />
  );
}

/** The pool's password policy as a checklist that ticks while the person types. */
export function PasswordRules({ password }: { readonly password: string }) {
  const { copy, surface } = useAuthLang();
  const missing = new Set<PasswordRule>(missingPasswordRules(password));
  const rules: ReadonlyArray<readonly [PasswordRule, string]> = [
    ["length", copy.password.rules.length(PASSWORD_POLICY.minLength)],
    ["lower", copy.password.rules.lower],
    ["upper", copy.password.rules.upper],
    ["number", copy.password.rules.number],
    ["symbol", copy.password.rules.symbol],
  ];
  return (
    <div className={`rounded-card px-3 py-2 text-sm ${SURFACE[surface].rules}`}>
      <p className="font-medium">{copy.password.rulesTitle}</p>
      <ul className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
        {rules.map(([rule, text]) => {
          const met = password.length > 0 && !missing.has(rule);
          return (
            <li key={rule} className={met ? SURFACE[surface].met : undefined}>
              <span aria-hidden="true">{met ? "✓ " : "· "}</span>
              {text}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ErrorNote({ children }: { readonly children: ReactNode }) {
  return (
    <div role="alert" className="rounded-card border-l-4 border-danger bg-danger-soft px-3 py-2 text-sm text-ink">
      {children}
    </div>
  );
}

export function NoticeNote({ children }: { readonly children: ReactNode }) {
  const { surface } = useAuthLang();
  return (
    <p role="status" className={`rounded-card px-3 py-2 text-sm ${SURFACE[surface].notice}`}>
      {children}
    </p>
  );
}

export function SubmitButton({ busy, busyLabel, children }: { readonly busy: boolean; readonly busyLabel?: string; readonly children: ReactNode }) {
  const { copy, surface } = useAuthLang();
  return (
    <button
      type="submit"
      disabled={busy}
      className={`inline-flex min-h-11 w-full items-center justify-center px-5 py-2.5 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${SURFACE[surface].submit}`}
    >
      {busy ? (busyLabel ?? copy.steps.working) : children}
    </button>
  );
}

export function LinkButton({ onClick, disabled, children }: { readonly onClick: () => void; readonly disabled?: boolean; readonly children: ReactNode }) {
  const { surface } = useAuthLang();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-11 items-center px-1 text-sm font-semibold underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-ink-muted disabled:no-underline ${SURFACE[surface].link}`}
    >
      {children}
    </button>
  );
}

/** The step's title: the page heading on an access screen, a sub-heading inside a drawer. */
export function StepHeading({ title, lead, inDrawer = false }: { readonly title: string; readonly lead?: string; readonly inDrawer?: boolean }) {
  const { surface } = useAuthLang();
  const Heading = inDrawer ? "h3" : "h1";
  return (
    <div>
      <Heading className={inDrawer ? "text-lg font-semibold text-navy" : SURFACE[surface].heading}>{title}</Heading>
      {lead ? <p className="mt-1.5 text-sm text-ink-muted">{lead}</p> : null}
    </div>
  );
}
