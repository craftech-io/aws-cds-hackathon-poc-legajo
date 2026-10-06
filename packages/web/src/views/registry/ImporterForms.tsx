// The importer's forms of the registry, each inside the drawer: the importer itself (FL-001), its
// WhatsApp opt-in with date, medium and text version, or its revocation (FL-001, FL-006), and the
// authorizations for the agent to write to each supplier of the firm (FL-003, FL-006).
import { ConsentMedium } from "@legajo/shared";
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { SelectField } from "../../components/SelectField";
import { isoToLocalInput, localInputToIso } from "../../lib/local-datetime";
import { DateTimeField } from "../clock/parts";
import { CONSENT_TEXT_VERSIONS, MEDIUM_LABELS, registryCopy } from "./copy";
import { ChangeOutcome, FormBody, FormFooter, TextField, useRegistryChange } from "./form-parts";
import { type ImporterRow, type SupplierRow, authorizationViews, consentSummary, isE164 } from "./registry-model";

interface FormProps {
  readonly onSaved: () => void;
  readonly onClose: () => void;
}

export function ImporterForm({ importer, onSaved, onClose }: FormProps & { readonly importer?: ImporterRow }) {
  const copy = registryCopy.importerForm;
  const change = useRegistryChange(onSaved);
  const [name, setName] = useState(importer?.name ?? "");
  const [contactName, setContactName] = useState(importer?.contactName ?? "");
  const [firstName, setFirstName] = useState(importer ? (importer.contactName.split(" ")[0] ?? "") : "");
  const [phone, setPhone] = useState("");
  const [touched, setTouched] = useState(false);
  const phoneRequired = importer === undefined;
  const phoneProblem = phone.trim() === "" ? (phoneRequired ? registryCopy.forms.required : undefined) : isE164(phone) ? undefined : copy.phoneInvalid;
  const phoneError = touched ? phoneProblem : undefined;
  const missing = (value: string) => (touched && value.trim() === "" ? registryCopy.forms.required : undefined);
  const valid = name.trim() !== "" && contactName.trim() !== "" && firstName.trim() !== "" && (phone.trim() === "" ? !phoneRequired : isE164(phone));

  const submit = () => {
    setTouched(true);
    if (!valid) return;
    void change.run({
      kind: "upsertImporter",
      input: {
        ...(importer ? { importerId: importer.importerId } : {}),
        name: name.trim(),
        contactName: contactName.trim(),
        contactFirstName: firstName.trim(),
        ...(phone.trim() === "" ? {} : { phoneE164: phone.trim() }),
        language: "es",
      },
    });
  };

  return (
    <FormBody onSubmit={submit}>
      <TextField label={copy.name} value={name} onChange={setName} error={missing(name)} autoComplete="organization" />
      <TextField label={copy.contactName} value={contactName} onChange={setContactName} error={missing(contactName)} autoComplete="name" />
      <TextField label={copy.contactFirstName} value={firstName} onChange={setFirstName} error={missing(firstName)} autoComplete="given-name" />
      <TextField label={copy.phone} type="tel" value={phone} onChange={setPhone} hint={importer ? `${copy.phoneHint} ${copy.phoneKeep}` : copy.phoneHint} error={phoneError} autoComplete="tel" />
      <FormFooter submit={copy.submit} disabled={change.state.status === "running"} onCancel={onClose} />
      <ChangeOutcome state={change.state} done={copy.saved} />
    </FormBody>
  );
}

const MEDIUM_OPTIONS = ConsentMedium.options.map((value) => ({ value, label: MEDIUM_LABELS[value] }));
const VERSION_OPTIONS = CONSENT_TEXT_VERSIONS.map((value) => ({ value, label: value }));

export function ConsentForm({ importer, simNow, onSaved, onClose }: FormProps & { readonly importer: ImporterRow; readonly simNow: string }) {
  const copy = registryCopy.consent;
  const change = useRegistryChange(onSaved);
  const [medium, setMedium] = useState<ConsentMedium>("SIGNED_FORM");
  const [version, setVersion] = useState<(typeof CONSENT_TEXT_VERSIONS)[number]>("v1");
  const [at, setAt] = useState(() => isoToLocalInput(simNow));
  const [reason, setReason] = useState("");
  // What the last change did: once it lands the lists reload and the form shows the other branch.
  const [last, setLast] = useState<"record" | "revoke">("record");
  const summary = consentSummary(importer.consent);
  const grantedAt = localInputToIso(at);
  const running = change.state.status === "running";
  const { importerId } = importer;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate">{copy.lead}</p>
      <p className="text-sm">
        <Badge tone={summary.tone}>{summary.text}</Badge>
      </p>
      {importer.consent.status === "GRANTED" ? (
        <FormBody
          onSubmit={() => {
            setLast("revoke");
            void change.run({ kind: "revokeConsent", input: { importerId, ...(reason.trim() === "" ? {} : { reason: reason.trim() }) } });
          }}
        >
          <p className="text-sm font-semibold text-navy">{copy.revokeTitle}</p>
          <p className="text-sm text-slate">{copy.revokeLead}</p>
          <TextField label={copy.reason} value={reason} onChange={setReason} />
          <FormFooter submit={copy.revoke} disabled={running} onCancel={onClose} />
        </FormBody>
      ) : (
        <FormBody
          onSubmit={() => {
            if (grantedAt === undefined) return;
            setLast("record");
            void change.run({ kind: "recordConsent", input: { importerId, medium, grantedAt, textVersion: version } });
          }}
        >
          <SelectField label={copy.medium} value={medium} options={MEDIUM_OPTIONS} onChange={setMedium} />
          <DateTimeField label={copy.grantedAt} value={at} onChange={setAt} hint={copy.grantedAtHint} />
          <SelectField label={copy.textVersion} value={version} options={VERSION_OPTIONS} onChange={setVersion} />
          <FormFooter submit={copy.record} disabled={running || grantedAt === undefined} onCancel={onClose} />
        </FormBody>
      )}
      <ChangeOutcome state={change.state} done={last === "revoke" ? copy.revoked_ : copy.recorded} />
    </div>
  );
}

export function AuthorizationForm({ importer, suppliers, onSaved }: Omit<FormProps, "onClose"> & { readonly importer: ImporterRow; readonly suppliers: readonly SupplierRow[] }) {
  const copy = registryCopy.authorization;
  const change = useRegistryChange(onSaved);
  const views = authorizationViews(importer, suppliers);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate">{copy.lead}</p>
      {views.length === 0 ? <p className="text-sm text-slate">{copy.none}</p> : null}
      <ul className="flex flex-col divide-y divide-mist rounded-md border border-mist">
        {views.map((view) => (
          <li key={view.supplierId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="font-medium text-navy">{view.supplierName}</p>
              <p className="mt-1">
                <Badge tone={view.authorized ? "success" : "neutral"}>{view.since ? copy.authorizedSince(view.since) : view.authorized ? copy.authorized : copy.notAuthorized}</Badge>
              </p>
            </div>
            <Button
              variant={view.authorized ? "secondary" : "primary"}
              busy={change.state.status === "running"}
              title={view.authorized ? copy.revoke(view.supplierName) : copy.grant(view.supplierName)}
              onClick={() => void change.run({ kind: "setAuthorization", input: { importerId: importer.importerId, supplierId: view.supplierId, authorized: !view.authorized } })}
            >
              {view.authorized ? copy.revokeShort : copy.grantShort}
            </Button>
          </li>
        ))}
      </ul>
      <ChangeOutcome state={change.state} done={copy.saved} />
    </div>
  );
}
