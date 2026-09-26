// Invariants 7, 8, 9 and 20 of docs/seed-spec.md §15: every phone and email belongs to one party in the
// whole seed and every world template; no reserved domain; supplier mailboxes only in our simulated
// domain or the SES mailbox simulator; every importer that is sent WhatsApp has an opt-in (except
// imp-litoral, without one on purpose); authorizations stay inside the firm; no party or firm mailbox
// is the QA injector's, and every party mailbox of a QA world carries its run and scenario.
import { QA_INJECTOR_PREFIX, SES_MAILBOX_SIMULATOR_DOMAIN, SIM_MAIL_DOMAIN, isReservedDomain } from "@legajo/shared";
import { str, type WorldView } from "./world-view";

/** The importer of the demo seed that has no opt-in on purpose (FL-002). */
export const WITHOUT_OPT_IN = new Set(["imp-litoral"]);

export interface AddressOwner {
  readonly address: string;
  readonly owner: string;
}

/** Every phone and mailbox of a world, with who owns it (world-qualified). */
export function addressesOf(view: WorldView, altContacts: readonly { supplierId: string; email: string }[] = []): AddressOwner[] {
  const owned = (address: unknown, owner: string): AddressOwner => ({ address: str(address).toLowerCase(), owner: `${view.label}/${owner}` });
  return [
    ...view.of("Importer").map((importer) => owned(importer.phoneE164, str(importer.importerId))),
    ...view.of("SupplierContact").map((contact) => owned(contact.email, str(contact.contactId))),
    ...view.of("Firm").map((firm) => owned(firm.mailboxAddress, str(firm.firmId))),
    ...altContacts.map((alt) => owned(alt.email, `${alt.supplierId}:alt`)),
  ];
}

/** Invariant 7 across worlds: one owner per address, no reserved domain, supplier mailboxes in our domains. */
export function addressProblems(addresses: readonly AddressOwner[]): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  for (const { address, owner } of addresses) {
    const previous = owners.get(address);
    if (previous !== undefined && previous !== owner) problems.push(`${address} belongs to ${previous} and to ${owner}`);
    owners.set(address, owner);
    if (!address.includes("@")) continue;
    const domain = address.slice(address.lastIndexOf("@") + 1);
    if (isReservedDomain(domain)) problems.push(`${owner} uses the reserved domain ${domain}`);
    if (domain !== SIM_MAIL_DOMAIN && domain !== SES_MAILBOX_SIMULATOR_DOMAIN) problems.push(`${owner}: ${address} is outside ${SIM_MAIL_DOMAIN} and ${SES_MAILBOX_SIMULATOR_DOMAIN}`);
  }
  return problems;
}

/** Invariants 8 and 9 in one world. */
export function consentAndAuthorizationProblems(view: WorldView): string[] {
  const problems: string[] = [];
  for (const importer of view.of("Importer")) {
    const id = str(importer.importerId);
    const consent = view.find("Consent", (item) => item.importerId === id);
    const granted = Array.isArray(consent?.history) && (consent.history as { action?: string }[]).some((entry) => entry.action === "GRANTED");
    if (!granted && !WITHOUT_OPT_IN.has(id)) problems.push(`${view.label}: ${id} has no WhatsApp opt-in`);
    if (granted && WITHOUT_OPT_IN.has(id)) problems.push(`${view.label}: ${id} must stay without an opt-in (FL-002)`);
  }
  for (const authorization of view.of("SupplierAuthorization")) {
    const supplier = view.find("Supplier", (item) => item.supplierId === authorization.supplierId);
    if (supplier === undefined || supplier.firmId !== authorization.firmId) problems.push(`${view.label}: authorization of ${str(authorization.importerId)} to ${str(authorization.supplierId)} points outside its firm`);
  }
  return problems;
}

const QA_PARTY_MAILBOX = /^qa-[A-Za-z0-9]+-[A-Za-z0-9]+-/;

/** Invariant 20: nobody is the injector; party mailboxes of a QA world carry `qa-<runId>-<scenario>-`. */
export function injectorProblems(view: WorldView, qaWorld: boolean, altContacts: readonly { email: string }[] = []): string[] {
  const problems: string[] = [];
  const parties = [...view.of("SupplierContact").map((contact) => str(contact.email)), ...altContacts.map((alt) => alt.email)];
  for (const address of [...parties, ...view.of("Firm").map((firm) => str(firm.mailboxAddress))]) {
    if (address.startsWith(QA_INJECTOR_PREFIX)) problems.push(`${view.label}: ${address} uses the injector's prefix`);
  }
  if (qaWorld) {
    for (const address of parties.filter((email) => email.endsWith(`@${SIM_MAIL_DOMAIN}`))) {
      if (!QA_PARTY_MAILBOX.test(address)) problems.push(`${view.label}: ${address} is a party of a QA world without qa-<runId>-<scenario>-`);
    }
  }
  return problems;
}
