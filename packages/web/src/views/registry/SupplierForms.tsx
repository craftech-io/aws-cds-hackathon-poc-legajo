// The supplier's forms of the registry, each inside the drawer: the supplier with its country, IANA
// time zone and first contacts (FL-004; an address outside the demo's recipient fence is refused
// with RECIPIENT_NOT_ALLOWED, a duplicated one with CONFLICT, both shown in the form), one more
// contact, and the behaviour of the simulated supplier, for all its operations or one (FL-088).
import { EmailInput, SupplierBehaviour } from "@legajo/shared";
import { useState } from "react";
import { SelectField } from "../../components/SelectField";
import { BEHAVIOUR_LABELS, registryCopy } from "./copy";
import { ChangeOutcome, FormBody, FormFooter, TextField, useRegistryChange } from "./form-parts";
import { type OperationScope, type SupplierRow, isCountryCode, isTimeZone, operationsOf, parseContactLines } from "./registry-model";

interface FormProps {
  readonly onSaved: () => void;
  readonly onClose: () => void;
}

export function SupplierForm({ supplier, onSaved, onClose }: FormProps & { readonly supplier?: SupplierRow }) {
  const copy = registryCopy.supplierForm;
  const change = useRegistryChange(onSaved);
  const [name, setName] = useState(supplier?.name ?? "");
  const [country, setCountry] = useState(supplier?.country ?? "");
  const [timezone, setTimezone] = useState(supplier?.timezone ?? "");
  const [contacts, setContacts] = useState("");
  const [touched, setTouched] = useState(false);
  const emails = parseContactLines(contacts);
  const errors = {
    name: touched && name.trim() === "" ? registryCopy.forms.required : undefined,
    country: touched && !isCountryCode(country.toUpperCase()) ? copy.countryInvalid : undefined,
    timezone: touched && !isTimeZone(timezone) ? copy.timezoneInvalid : undefined,
    contacts: touched && emails === undefined ? copy.emailInvalid : undefined,
  };
  const valid = name.trim() !== "" && isCountryCode(country.toUpperCase()) && isTimeZone(timezone) && emails !== undefined;

  const submit = () => {
    setTouched(true);
    if (!valid || emails === undefined) return;
    void change.run({
      kind: "upsertSupplier",
      input: {
        ...(supplier ? { supplierId: supplier.supplierId } : {}),
        name: name.trim(),
        country: country.trim().toUpperCase(),
        timezone: timezone.trim(),
        language: "en",
        ...(emails.length > 0 ? { contacts: emails } : {}),
      },
    });
  };

  return (
    <FormBody onSubmit={submit}>
      <TextField label={copy.name} value={name} onChange={setName} error={errors.name} autoComplete="organization" />
      <TextField label={copy.country} value={country} onChange={setCountry} error={errors.country} autoComplete="country" />
      <TextField label={copy.timezone} value={timezone} onChange={setTimezone} hint={copy.timezoneHint} error={errors.timezone} />
      <TextField label={copy.contacts} value={contacts} onChange={setContacts} hint={copy.contactsHint} error={errors.contacts} multiline />
      <FormFooter submit={copy.submit} disabled={change.state.status === "running"} onCancel={onClose} />
      <ChangeOutcome state={change.state} done={copy.saved} />
    </FormBody>
  );
}

export function ContactForm({ supplier, onSaved, onClose }: FormProps & { readonly supplier: SupplierRow }) {
  const copy = registryCopy.contactForm;
  const change = useRegistryChange(onSaved);
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const parsed = EmailInput.safeParse(email);
  const submit = () => {
    setTouched(true);
    if (parsed.success) void change.run({ kind: "upsertContact", input: { supplierId: supplier.supplierId, email: parsed.data } });
  };
  return (
    <FormBody onSubmit={submit}>
      <TextField label={copy.email} type="email" value={email} onChange={setEmail} hint={copy.hint} error={touched && !parsed.success ? registryCopy.supplierForm.emailInvalid : undefined} autoComplete="email" />
      <FormFooter submit={copy.submit} disabled={change.state.status === "running"} onCancel={onClose} />
      <ChangeOutcome state={change.state} done={copy.saved} />
    </FormBody>
  );
}

const BEHAVIOUR_OPTIONS = SupplierBehaviour.options.map((value) => ({ value, label: BEHAVIOUR_LABELS[value] }));
const ALL = "ALL";

interface BehaviourFormProps extends FormProps {
  readonly supplier: SupplierRow;
  readonly operations: readonly OperationScope[];
}

export function BehaviourForm({ supplier, operations, onSaved, onClose }: BehaviourFormProps) {
  const copy = registryCopy.behaviourForm;
  const change = useRegistryChange(onSaved);
  const [behaviour, setBehaviour] = useState<SupplierBehaviour>(supplier.behaviour);
  const [scope, setScope] = useState<string>(ALL);
  const scopes = [{ value: ALL, label: copy.allOperations }, ...operationsOf(supplier.supplierId, operations).map((operation) => ({ value: operation.operationId, label: copy.operation(operation.operationNumber) }))];
  const submit = () => void change.run({ kind: "setBehaviour", input: { supplierId: supplier.supplierId, behaviour, ...(scope === ALL ? {} : { operationId: scope }) } });
  return (
    <FormBody onSubmit={submit}>
      <p className="text-sm text-slate">{copy.lead}</p>
      <SelectField label={copy.behaviour} value={behaviour} options={BEHAVIOUR_OPTIONS} onChange={setBehaviour} />
      <SelectField label={copy.scope} value={scope} options={scopes} onChange={setScope} />
      <FormFooter submit={copy.submit} disabled={change.state.status === "running"} onCancel={onClose} />
      <ChangeOutcome state={change.state} done={copy.saved} />
    </FormBody>
  );
}
