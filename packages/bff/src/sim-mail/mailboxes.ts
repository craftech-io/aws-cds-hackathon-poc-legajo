// Which simulated mailbox received a mail (docs/architecture-integrations.md §3, "El destinatario
// decide"). Every mailbox lives in `sim.legajo.demo.craftech.io`:
//
//   estudio-<slug>@                               a firm's mailbox (estudio-delta, estudio-g<nn>,
//                                                 estudio-qa-<runId>-<scenario>): the demo mailbox
//   supplier-<code>@, g<nn>-<code>@,              a supplier's mailbox in the demo, a guest world or a QA
//   qa-<runId>-<scenario>-<key>-<code>@           world: the supplier simulator
//   qa-signup-<runId>-<key>@                      the scenario runner's sign-up mailboxes: Cognito account
//                                                 emails land here, are kept by the receipt rule's S3
//                                                 action for `signup.readCode`, and are dropped quietly
//   anything else (the `qainject-` injector too)  an audited discard
//
// The address only routes; the data decides: the outbound message the mail is verified against has to
// agree (a `FIRM` counterpart for a firm's mailbox, a `SUPPLIER` one for a supplier's).
import { QA_INJECTOR_PREFIX, SIM_MAIL_DOMAIN } from "@legajo/shared";
import { parseAddress } from "../channels/email/address";
import { QA_SIGNUP_MAILBOX } from "../signup/bot-checks";

export type MailboxKind = "FIRM" | "SUPPLIER" | "ACCOUNT" | "OTHER";

const TOKENS = "[a-z0-9]+(?:-[a-z0-9]+)*";
const FIRM_MAILBOX = new RegExp(`^estudio-${TOKENS}$`);
const SUPPLIER_MAILBOXES: readonly RegExp[] = [new RegExp(`^supplier-${TOKENS}$`), new RegExp(`^g\\d{2}-${TOKENS}$`), new RegExp(`^qa-${TOKENS}$`)];

export function mailboxKind(address: string): MailboxKind {
  const parsed = parseAddress(address);
  if (!parsed.ok || parsed.value.domain !== SIM_MAIL_DOMAIN) return "OTHER";
  const { local } = parsed.value;
  if (QA_SIGNUP_MAILBOX.test(local)) return "ACCOUNT";
  if (local.startsWith(QA_INJECTOR_PREFIX)) return "OTHER";
  if (FIRM_MAILBOX.test(local)) return "FIRM";
  return SUPPLIER_MAILBOXES.some((pattern) => pattern.test(local)) ? "SUPPLIER" : "OTHER";
}
