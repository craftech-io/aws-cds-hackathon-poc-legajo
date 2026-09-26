// The two tables of the registry: importers (masked phone, opt-in with date, medium and text version,
// the suppliers they authorized) and suppliers (contacts masked with their status, time zone,
// language, simulated behaviour). Each row opens its forms in the drawer; a contact still pending
// confirmation can be confirmed right from the row.
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Button } from "../../components/Button";
import { type Column, Table } from "../../components/Table";
import type { Action } from "../../lib/use-remote";
import { BEHAVIOUR_LABELS, CONTACT_STATUS_LABELS, LANGUAGE_LABELS, registryCopy } from "./copy";
import type { RegistryChange } from "./registry-api";
import { type ContactRow, type ImporterRow, type SupplierRow, authorizedNames, consentSummary, profileLines } from "./registry-model";

export type RegistryPanel =
  | { readonly kind: "newImporter" }
  | { readonly kind: "editImporter" | "consent" | "authorizations"; readonly importerId: string }
  | { readonly kind: "newSupplier" }
  | { readonly kind: "editSupplier" | "contact" | "behaviour"; readonly supplierId: string };

type Open = (panel: RegistryPanel) => void;

function RowActions({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap gap-1">{children}</div>;
}

function RowButton({ label, title, onClick }: { readonly label: string; readonly title: string; readonly onClick: () => void }) {
  return (
    <Button variant="ghost" title={title} onClick={onClick}>
      {label}
    </Button>
  );
}

export function ImportersTable({ importers, suppliers, open }: { readonly importers: readonly ImporterRow[]; readonly suppliers: readonly SupplierRow[]; readonly open: Open }) {
  const copy = registryCopy.importers;
  const columns: readonly Column<ImporterRow>[] = [
    {
      id: "name",
      header: copy.name,
      cell: (row) => (
        <>
          <p className="font-medium text-navy">{row.name}</p>
          <p className="text-xs text-slate">{row.contactName}</p>
        </>
      ),
    },
    { id: "phone", header: copy.phone, cell: (row) => <span className="font-mono text-xs">{row.phoneMasked}</span> },
    {
      id: "consent",
      header: copy.consent,
      cell: (row) => {
        const summary = consentSummary(row.consent);
        return <Badge tone={summary.tone}>{summary.text}</Badge>;
      },
    },
    {
      id: "authorizations",
      header: copy.authorizations,
      cell: (row) => {
        const names = authorizedNames(row, suppliers);
        return names.length === 0 ? <span className="text-xs text-slate">{copy.noAuthorizations}</span> : <span className="text-sm">{names.join(", ")}</span>;
      },
    },
    {
      id: "actions",
      header: copy.actions,
      cell: (row) => (
        <RowActions>
          <RowButton label={copy.edit} title={copy.editLabel(row.name)} onClick={() => open({ kind: "editImporter", importerId: row.importerId })} />
          <RowButton label={copy.consentAction} title={copy.consentLabel(row.name)} onClick={() => open({ kind: "consent", importerId: row.importerId })} />
          <RowButton label={copy.authorize} title={copy.authorizeLabel(row.name)} onClick={() => open({ kind: "authorizations", importerId: row.importerId })} />
        </RowActions>
      ),
    },
  ];
  return <Table columns={columns} rows={importers} keyOf={(row) => row.importerId} emptyTitle={copy.empty} caption={copy.title} variant="inset" />;
}

const CONTACT_TONES: Readonly<Record<ContactRow["status"], BadgeTone>> = {
  PENDING_CONFIRMATION: "warning",
  ACTIVE: "success",
  BOUNCED: "danger",
  COMPLAINED: "danger",
};

function Contacts({ supplier, confirm }: { readonly supplier: SupplierRow; readonly confirm: Action<RegistryChange, unknown> }) {
  const copy = registryCopy.suppliers;
  if (supplier.contacts.length === 0) return <span className="text-xs text-slate">{copy.noContacts}</span>;
  return (
    <ul className="flex flex-col gap-1">
      {supplier.contacts.map((contact) => (
        <li key={contact.contactId} className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{contact.emailMasked}</span>
          <Badge tone={CONTACT_TONES[contact.status]}>{CONTACT_STATUS_LABELS[contact.status]}</Badge>
          {contact.status === "PENDING_CONFIRMATION" ? (
            <Button
              variant="secondary"
              title={copy.confirmLabel(contact.emailMasked)}
              disabled={confirm.state.status === "running"}
              onClick={() => void confirm.run({ kind: "confirmContact", input: { contactId: contact.contactId } })}
            >
              {copy.confirm}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface SuppliersTableProps {
  readonly suppliers: readonly SupplierRow[];
  readonly open: Open;
  readonly confirm: Action<RegistryChange, unknown>;
}

export function SuppliersTable({ suppliers, open, confirm }: SuppliersTableProps) {
  const copy = registryCopy.suppliers;
  const columns: readonly Column<SupplierRow>[] = [
    {
      id: "name",
      header: copy.name,
      cell: (row) => (
        <>
          <p className="font-medium text-navy">{row.name}</p>
          <p className="text-xs text-slate">{row.country}</p>
        </>
      ),
    },
    { id: "contacts", header: copy.contacts, cell: (row) => <Contacts supplier={row} confirm={confirm} /> },
    { id: "timezone", header: copy.timezone, cell: (row) => row.timezone },
    { id: "language", header: copy.language, cell: (row) => LANGUAGE_LABELS[row.language] },
    {
      id: "profile",
      header: copy.profile,
      cell: (row) => {
        const lines = profileLines(row);
        return lines.length === 0 ? <span className="text-xs text-slate">{copy.noProfile}</span> : <span className="text-sm">{lines.join(" · ")}</span>;
      },
    },
    { id: "behaviour", header: copy.behaviour, cell: (row) => <span className="text-sm">{BEHAVIOUR_LABELS[row.behaviour]}</span> },
    {
      id: "actions",
      header: copy.actions,
      cell: (row) => (
        <RowActions>
          <RowButton label={copy.edit} title={copy.editLabel(row.name)} onClick={() => open({ kind: "editSupplier", supplierId: row.supplierId })} />
          <RowButton label={copy.addContact} title={copy.addContactLabel(row.name)} onClick={() => open({ kind: "contact", supplierId: row.supplierId })} />
          <RowButton label={copy.setBehaviour} title={copy.setBehaviourLabel(row.name)} onClick={() => open({ kind: "behaviour", supplierId: row.supplierId })} />
        </RowActions>
      ),
    },
  ];
  return <Table columns={columns} rows={suppliers} keyOf={(row) => row.supplierId} emptyTitle={copy.empty} caption={copy.title} variant="inset" />;
}
