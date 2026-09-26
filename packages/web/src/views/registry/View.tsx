// Registro (`/app/registry`, docs/design-brief.md §6): the importers of the world with their WhatsApp
// opt-in (date, medium, text version) and supplier authorizations, and the suppliers with their
// contacts, time zone, language and simulated behaviour (FL-001, FL-003, FL-004, FL-006, FL-088).
// Lists come from `registry.importers.list` and `registry.suppliers.list`; every change opens in a
// drawer and reloads both lists when it lands. Phones and emails are masked by the BFF.
import { type ReactNode, useCallback, useState } from "react";
import { Button } from "../../components/Button";
import { Drawer } from "../../components/Drawer";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section } from "../../components/Section";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote, useWorldClock } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { dataOf } from "../../lib/use-remote";
import { registryCopy } from "./copy";
import { ChangeOutcome, useRegistryChange } from "./form-parts";
import { AuthorizationForm, ConsentForm, ImporterForm } from "./ImporterForms";
import type { ImporterRow, OperationScope, SupplierRow } from "./registry-model";
import { BehaviourForm, ContactForm, SupplierForm } from "./SupplierForms";
import { ImportersTable, type RegistryPanel, SuppliersTable } from "./Tables";

interface PanelProps {
  readonly panel: RegistryPanel;
  readonly importers: readonly ImporterRow[];
  readonly suppliers: readonly SupplierRow[];
  readonly operations: readonly OperationScope[];
  readonly simNow: string;
  readonly onSaved: () => void;
  readonly onClose: () => void;
}

/** Title and form of the open panel; the row is read from the latest lists, so a saved change shows at once. */
function panelContent({ panel, importers, suppliers, operations, simNow, onSaved, onClose }: PanelProps): { title: string; body: ReactNode } | undefined {
  const saved = { onSaved, onClose };
  if (panel.kind === "newImporter") return { title: registryCopy.importerForm.newTitle, body: <ImporterForm {...saved} /> };
  if (panel.kind === "newSupplier") return { title: registryCopy.supplierForm.newTitle, body: <SupplierForm {...saved} /> };
  if ("importerId" in panel) {
    const importer = importers.find((row) => row.importerId === panel.importerId);
    if (importer === undefined) return undefined;
    if (panel.kind === "editImporter") return { title: registryCopy.importerForm.editTitle(importer.name), body: <ImporterForm importer={importer} {...saved} /> };
    if (panel.kind === "consent") return { title: registryCopy.consent.title(importer.name), body: <ConsentForm importer={importer} simNow={simNow} {...saved} /> };
    return { title: registryCopy.authorization.title(importer.name), body: <AuthorizationForm importer={importer} suppliers={suppliers} onSaved={onSaved} /> };
  }
  if (!("supplierId" in panel)) return undefined;
  const supplier = suppliers.find((row) => row.supplierId === panel.supplierId);
  if (supplier === undefined) return undefined;
  if (panel.kind === "editSupplier") return { title: registryCopy.supplierForm.editTitle(supplier.name), body: <SupplierForm supplier={supplier} {...saved} /> };
  if (panel.kind === "contact") return { title: registryCopy.contactForm.title(supplier.name), body: <ContactForm supplier={supplier} {...saved} /> };
  return { title: registryCopy.behaviourForm.title(supplier.name), body: <BehaviourForm supplier={supplier} operations={operations} {...saved} /> };
}

export default function View() {
  const { trpc } = useSession();
  const { snapshot } = useWorldClock();
  const importers = useLiveRemote("registry.importers.list", (signal) => trpc.registry.importers.list.query({}, { signal }));
  const suppliers = useLiveRemote("registry.suppliers.list", (signal) => trpc.registry.suppliers.list.query({}, { signal }));
  const operations = useLiveRemote("registry:operations", (signal) => trpc.operations.list.query({}, { signal }));
  const [panel, setPanel] = useState<RegistryPanel | undefined>(undefined);
  const { reload: reloadImporters } = importers;
  const { reload: reloadSuppliers } = suppliers;
  const reload = useCallback(() => {
    reloadImporters();
    reloadSuppliers();
  }, [reloadImporters, reloadSuppliers]);
  const confirm = useRegistryChange(reload);
  const close = useCallback(() => setPanel(undefined), []);

  const importerRows = dataOf(importers.state)?.importers ?? [];
  const supplierRows = dataOf(suppliers.state)?.suppliers ?? [];
  const operationRows = dataOf(operations.state)?.operations ?? [];
  const content =
    panel === undefined
      ? undefined
      : panelContent({ panel, importers: importerRows, suppliers: supplierRows, operations: operationRows, simNow: snapshot?.simNow ?? new Date().toISOString(), onSaved: reload, onClose: close });
  const view = consoleCopy.views.registry;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={view.title} description={view.description} />
      <Section
        id="registry-importers"
        title={registryCopy.importers.title}
        description={registryCopy.importers.description}
        actions={<Button onClick={() => setPanel({ kind: "newImporter" })}>{registryCopy.importers.add}</Button>}
      >
        <RemoteBlock state={importers.state} onRetry={importers.reload}>
          {(data) => <ImportersTable importers={data.importers} suppliers={supplierRows} open={setPanel} />}
        </RemoteBlock>
      </Section>
      <Section
        id="registry-suppliers"
        title={registryCopy.suppliers.title}
        description={registryCopy.suppliers.description}
        actions={<Button onClick={() => setPanel({ kind: "newSupplier" })}>{registryCopy.suppliers.add}</Button>}
      >
        <div className="flex flex-col gap-3">
          <ChangeOutcome state={confirm.state} done={registryCopy.suppliers.confirmed} />
          <RemoteBlock state={suppliers.state} onRetry={suppliers.reload}>
            {(data) => <SuppliersTable suppliers={data.suppliers} open={setPanel} confirm={confirm} />}
          </RemoteBlock>
        </div>
      </Section>
      <Drawer open={content !== undefined} title={content?.title ?? ""} onClose={close} closeLabel={registryCopy.forms.close}>
        {content?.body}
      </Drawer>
    </div>
  );
}
