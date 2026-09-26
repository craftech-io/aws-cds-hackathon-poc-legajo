// `mailbox` router (docs/tool-catalog.md, FL-084): the demo mailboxes of a world, the firm's own
// (`estudio-…@sim…`, where escalations land) and its suppliers' simulated ones. A mail is shown only
// when the firm of the operation of the verified outbound message it answers is the principal's
// firm (`MailboxMessage.firmId`), never because of the address it came to; the body is plain text.
import { z } from "zod";
import type { Connector } from "../connector/index";
import type { MailboxMessage } from "../domain/conversations";
import { EmailAddress } from "../domain/common";
import { WorldFields, WorldInput, worldOf } from "./clock";
import { refusal } from "./errors";
import { firmProcedure, router } from "./trpc";

/** Newest mails listed per mailbox. */
export const MAILBOX_LIST_LIMIT = 50;

export interface WorldMailbox {
  readonly address: string;
  readonly owner: "FIRM" | "SUPPLIER";
  readonly supplierId?: string;
}

/** The firm's mailbox and the mailboxes of the contacts of the world's suppliers. */
export async function mailboxesOf(data: Connector, firmId: string, clockId: string): Promise<WorldMailbox[]> {
  const [firm, suppliers] = await Promise.all([data.firms.getFirm(firmId), data.parties.listSuppliers(firmId, { clockId })]);
  const contacts = await Promise.all(suppliers.map((supplier) => data.parties.listContacts(supplier.supplierId)));
  const seen = new Set<string>([firm.mailboxAddress]);
  const mailboxes: WorldMailbox[] = [{ address: firm.mailboxAddress, owner: "FIRM" }];
  contacts.flat().forEach((contact) => {
    if (seen.has(contact.email)) return;
    seen.add(contact.email);
    mailboxes.push({ address: contact.email, owner: "SUPPLIER", supplierId: contact.supplierId });
  });
  return mailboxes;
}

function visibleTo(firmId: string, clockId: string, mail: MailboxMessage): boolean {
  return mail.firmId === firmId && (mail.clockId === undefined || mail.clockId === clockId);
}

function headerView(mail: MailboxMessage) {
  return {
    mailboxAddress: mail.mailboxAddress,
    mailboxMessageId: mail.mailboxMessageId,
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    receivedAtReal: mail.receivedAtReal,
    ...(mail.receivedAtSim === undefined ? {} : { receivedAtSim: mail.receivedAtSim }),
    ...(mail.operationId === undefined ? {} : { operationId: mail.operationId }),
  };
}

const GetInput = WorldFields.extend({ mailboxAddress: EmailAddress, mailboxMessageId: z.string().trim().min(1).max(128) }).strict();

export const mailboxRouter = router({
  list: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
    const data = ctx.deps.connector;
    const { firmId } = ctx.principal;
    const clockId = await worldOf(ctx, input.clockId);
    const mailboxes = await mailboxesOf(data, firmId, clockId);
    const listed = await Promise.all(
      mailboxes.map(async (mailbox) => {
        const mails = await data.conversations.listMailbox(mailbox.address, { limit: MAILBOX_LIST_LIMIT });
        return { ...mailbox, messages: mails.filter((mail) => visibleTo(firmId, clockId, mail)).map(headerView) };
      }),
    );
    return { clockId, mailboxes: listed };
  }),

  get: firmProcedure.input(GetInput).query(async ({ ctx, input }) => {
    const data = ctx.deps.connector;
    const { firmId } = ctx.principal;
    const clockId = await worldOf(ctx, input.clockId);
    const mailboxes = await mailboxesOf(data, firmId, clockId);
    if (!mailboxes.some((mailbox) => mailbox.address === input.mailboxAddress)) throw refusal("NOT_FOUND", "no such mail in this world");
    const mails = await data.conversations.listMailbox(input.mailboxAddress);
    const mail = mails.find((candidate) => candidate.mailboxMessageId === input.mailboxMessageId);
    if (mail === undefined || !visibleTo(firmId, clockId, mail)) throw refusal("NOT_FOUND", "no such mail in this world");
    return { ...headerView(mail), bodyText: mail.bodyText };
  }),
});
