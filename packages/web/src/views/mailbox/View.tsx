// Buzón de demo (`/app/mailbox`, docs/design-brief.md §6, FL-084): the emails the simulated mailboxes
// of the firm (escalations) and of its suppliers (the agent's requests) received through SES, read
// only. The BFF lists only mails whose firm, the firm of the operation of the verified outbound
// message, is the user's; this view shows them newest first, one mailbox or all, and opens one in
// plain text. The list follows the world at the shell's cadence.
import { useState } from "react";
import { DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { SelectField } from "../../components/SelectField";
import type { Column } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { formatSimDateTime } from "../../lib/format";
import { dataOf } from "../../lib/use-remote";
import { mailboxCopy } from "./copy";
import { MailReader } from "./MailReader";
import { ALL_MAILBOXES, type MailRow, type MailboxList, displayAddress, mailRows, mailboxLabel, selectedMail, threadOf } from "./mailbox-model";

// Headers are getters so the columns follow the console's language after import.
const COLUMNS: readonly Column<MailRow>[] = [
  {
    id: "subject",
    get header() {
      return mailboxCopy.reader.subject;
    },
    cell: (row) => <span className="font-medium text-navy">{row.subject || mailboxCopy.list.noSubject}</span>,
  },
  {
    id: "from",
    get header() {
      return mailboxCopy.reader.from;
    },
    cell: (row) => displayAddress(row.from),
  },
  {
    id: "thread",
    get header() {
      return mailboxCopy.reader.thread;
    },
    cell: (row) => threadOf(row) ?? "—",
  },
  {
    id: "at",
    get header() {
      return mailboxCopy.reader.receivedSim;
    },
    cell: (row) => formatSimDateTime(row.sortAt),
  },
];

function Mailboxes({ list, supplierNames }: { readonly list: MailboxList; readonly supplierNames: ReadonlyMap<string, string> }) {
  const [mailbox, setMailbox] = useState<string>(ALL_MAILBOXES);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const rows = mailRows(list, mailbox);
  const current = selectedMail(rows, chosen);
  const labels = new Map(list.mailboxes.map((entry) => [entry.address, mailboxLabel(entry, supplierNames)] as const));
  const options = [{ value: ALL_MAILBOXES, label: mailboxCopy.all }, ...list.mailboxes.map((entry) => ({ value: entry.address, label: labels.get(entry.address) ?? entry.address }))];

  return (
    <div className="flex flex-col gap-4">
      <SelectField label={mailboxCopy.filter} value={mailbox} options={options} onChange={setMailbox} className="min-w-72" />
      <div className="grid gap-6 2xl:grid-cols-2">
        <section aria-label={mailboxCopy.list.title}>
          <DataTable
            columns={COLUMNS}
            rows={rows}
            keyOf={(row) => row.key}
            caption={mailboxCopy.list.title}
            emptyTitle={mailboxCopy.list.empty}
            emptyLead={mailboxCopy.list.emptyLead}
            onRowClick={(row) => setChosen(row.key)}
            {...(current ? { activeKey: current.key } : {})}
          />
        </section>
        <MailReader mail={current} mailboxName={current ? (labels.get(current.mailboxAddress) ?? current.mailboxAddress) : ""} />
      </div>
    </div>
  );
}

export default function View() {
  const { trpc } = useSession();
  const list = useLiveRemote("mailbox.list", (signal) => trpc.mailbox.list.query({}, { signal }));
  const suppliers = useLiveRemote("mailbox:suppliers", (signal) => trpc.registry.suppliers.list.query({}, { signal }));
  const supplierNames = new Map((dataOf(suppliers.state)?.suppliers ?? []).map((supplier) => [supplier.supplierId, supplier.name] as const));
  const view = consoleCopy.views.mailbox;
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <p className="mb-4 max-w-3xl text-sm text-slate">{mailboxCopy.lead}</p>
      <RemoteBlock state={list.state} onRetry={list.reload}>
        {(data) => <Mailboxes list={data} supplierNames={supplierNames} />}
      </RemoteBlock>
    </div>
  );
}
