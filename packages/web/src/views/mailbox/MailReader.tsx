// One mail of the demo mailbox (`mailbox.get`): its thread headers and its body as plain text. The
// body is rendered as a text node inside <pre>, so whatever it contains (markup included) is shown as
// characters and never interpreted: no HTML, no dangerouslySetInnerHTML, no iframe (FL-084).
import type { ReactNode } from "react";
import { EmptyState } from "../../components/EmptyState";
import { RemoteBlock } from "../../components/RemoteBlock";
import { useSession } from "../../context/SessionContext";
import { formatDateTime, formatSimDateTime } from "../../lib/format";
import type { RouterOutputs } from "../../lib/trpc-router";
import { useRemoteInput } from "../../lib/use-remote";
import { mailboxCopy } from "./copy";
import { type MailRow, displayAddress, threadOf } from "./mailbox-model";

type Mail = RouterOutputs["mailbox"]["get"];

const copy = mailboxCopy.reader;

function Header({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
      <dt className="font-semibold text-slate">{label}</dt>
      <dd className="break-words text-ink">{children}</dd>
    </div>
  );
}

function MailBody({ mail, mailboxName }: { readonly mail: Mail; readonly mailboxName: string }) {
  const thread = threadOf(mail);
  return (
    <article aria-label={copy.title} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-navy">{mail.subject || mailboxCopy.list.noSubject}</h2>
      <dl className="flex flex-col gap-1.5">
        <Header label={copy.from}>{displayAddress(mail.from)}</Header>
        <Header label={copy.to}>{displayAddress(mail.to)}</Header>
        <Header label={copy.mailbox}>{mailboxName}</Header>
        {thread ? <Header label={copy.thread}>{thread}</Header> : null}
        {mail.receivedAtSim ? <Header label={copy.receivedSim}>{formatSimDateTime(mail.receivedAtSim)}</Header> : null}
        <Header label={copy.receivedReal}>{formatDateTime(mail.receivedAtReal)}</Header>
      </dl>
      <section aria-label={copy.body}>
        <pre className="max-h-128 overflow-auto whitespace-pre-wrap break-words rounded-md border border-mist bg-paper p-4 font-sans text-sm text-ink">{mail.bodyText}</pre>
      </section>
    </article>
  );
}

export function MailReader({ mail, mailboxName }: { readonly mail: MailRow | undefined; readonly mailboxName: string }) {
  const { trpc } = useSession();
  const input = mail === undefined ? undefined : { mailboxAddress: mail.mailboxAddress, mailboxMessageId: mail.mailboxMessageId };
  const detail = useRemoteInput("mailbox.get", input, (value, signal) => trpc.mailbox.get.query(value, { signal }));
  if (mail === undefined) return <EmptyState title={copy.none} />;
  return (
    <div className="rounded-card border border-mist bg-white p-5 shadow-card">
      <RemoteBlock state={detail.state} onRetry={detail.reload}>
        {(data) => <MailBody mail={data} mailboxName={mailboxName} />}
      </RemoteBlock>
    </div>
  );
}
