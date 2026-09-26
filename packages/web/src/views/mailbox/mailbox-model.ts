// Pure rules of the demo mailbox (FL-084): one list of every mail of the world's mailboxes, newest
// first (simulated hour, else real), filtered by mailbox; how an address reads (an operation's thread
// address is named by its operation, never shown with its tag); and how each mailbox is named.
import { operationNumberOf, parseThreadAddress } from "@legajo/shared";
import type { RouterOutputs } from "../../lib/trpc-router";
import { mailboxCopy } from "./copy";

export type MailboxList = RouterOutputs["mailbox"]["list"];
export type Mailbox = MailboxList["mailboxes"][number];
export type MailHeader = Mailbox["messages"][number];

export interface MailRow extends MailHeader {
  /** `mailboxAddress#mailboxMessageId`: unique across the world's mailboxes. */
  readonly key: string;
  readonly sortAt: string;
}

export const ALL_MAILBOXES = "ALL";

export function mailKey(mail: Pick<MailHeader, "mailboxAddress" | "mailboxMessageId">): string {
  return `${mail.mailboxAddress}#${mail.mailboxMessageId}`;
}

/** Every mail of the chosen mailbox (or all), newest first. */
export function mailRows(list: Pick<MailboxList, "mailboxes">, mailbox: string = ALL_MAILBOXES): MailRow[] {
  return list.mailboxes
    .filter((candidate) => mailbox === ALL_MAILBOXES || candidate.address === mailbox)
    .flatMap((candidate) => candidate.messages.map((mail) => ({ ...mail, key: mailKey(mail), sortAt: mail.receivedAtSim ?? mail.receivedAtReal })))
    .sort((a, b) => Date.parse(b.sortAt) - Date.parse(a.sortAt) || a.key.localeCompare(b.key));
}

/** `op-4471-k7p2q9@legajo…` reads "dirección de la operación 4471"; any other address as it is. */
export function displayAddress(address: string): string {
  const thread = parseThreadAddress(address);
  return thread === undefined ? address : mailboxCopy.threadAddress(thread.operationNumber);
}

/** "Operación 4471" for the thread of a mail; undefined when it is not about one operation. */
export function threadOf(mail: Pick<MailHeader, "operationId">): string | undefined {
  if (mail.operationId === undefined) return undefined;
  try {
    return mailboxCopy.reader.threadOf(operationNumberOf(mail.operationId));
  } catch {
    return undefined;
  }
}

/** "Buzón del estudio" or "Proveedor: <name>" (the name from the registry, when it is known). */
export function mailboxLabel(mailbox: Pick<Mailbox, "owner" | "supplierId">, supplierNames: ReadonlyMap<string, string>): string {
  if (mailbox.owner === "FIRM") return mailboxCopy.firmMailbox;
  const name = mailbox.supplierId === undefined ? undefined : supplierNames.get(mailbox.supplierId);
  return name === undefined ? mailboxCopy.unknownSupplier : mailboxCopy.supplierMailbox(name);
}

/** The mail to show: the chosen one while it is still listed, else the newest. */
export function selectedMail(rows: readonly MailRow[], chosen: string | undefined): MailRow | undefined {
  return rows.find((row) => row.key === chosen) ?? rows[0];
}
