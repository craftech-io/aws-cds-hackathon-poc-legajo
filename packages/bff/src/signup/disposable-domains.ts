// Disposable-mailbox domains `SignupDispatch` suppresses (`DISPOSABLE_DOMAIN`, ADR-0015 §3.2): a code
// sent to a throwaway inbox makes a confirmed account nobody comes back to, and a lead nobody can reach.
// Lower case, no subdomains (a subdomain of a listed domain is suppressed too). Adding a domain is a
// pull request.
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com",
  "20minutemail.com",
  "33mail.com",
  "anonaddy.me",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "euploading.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "inboxkitten.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mailpoof.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "spambox.us",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.dev",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

/** Mail exchangers of disposable-mailbox services: a domain whose every MX is one of these is disposable too. */
export const DISPOSABLE_MX_HOSTS: ReadonlySet<string> = new Set(["mx.smtp.is"]);

/** True when the domain has MX records and all of them point at a listed exchanger. */
export function isDisposableExchanger(exchanges: readonly string[]): boolean {
  return exchanges.length > 0 && exchanges.every((exchange) => DISPOSABLE_MX_HOSTS.has(exchange.toLowerCase().replace(/\.$/, "")));
}

/** True for a listed domain or any subdomain of one. */
export function isDisposableDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split(".");
  for (let start = 0; start < labels.length - 1; start += 1) if (DISPOSABLE_DOMAINS.has(labels.slice(start).join("."))) return true;
  return false;
}
