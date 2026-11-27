// Disposable-mailbox domains `SignupDispatch` suppresses (`DISPOSABLE_DOMAIN`, ADR-0015 §3.2): a code
// sent to a throwaway inbox makes a confirmed account nobody comes back to, and a lead nobody can reach.
// Two lists, both lower case and matched with their subdomains: the public, maintained one of the
// `disposable-email-domains` package (data only, pinned, server side only: this module never reaches the
// web) and the repository's own below, for the domains seen in sign-ups before the public list has them.
// Adding a domain of our own is a pull request.
import publicDomains from "disposable-email-domains/index.json" with { type: "json" };
import publicWildcards from "disposable-email-domains/wildcard.json" with { type: "json" };

export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10mail.org",
  "10minutemail.com",
  "1secmail.com",
  "20minutemail.com",
  "33mail.com",
  "anonaddy.me",
  "blondmail.com",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "emlpro.com",
  "emltmp.com",
  "euploading.com",
  "fakeinbox.com",
  "freeml.net",
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
  "mailpwr.com",
  "mailtowin.com",
  "maximail.vip",
  "mimimail.me",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "pickmail.org",
  "sharklasers.com",
  "spambox.us",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.dev",
  "tempmail.lol",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "vomoto.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

/** Mail providers of disposable mailboxes: any MX under one of these serves throwaway inboxes, whatever the domain. */
export const DISPOSABLE_MX_PROVIDERS: ReadonlySet<string> = new Set(["smtp.is"]);

/**
 * Addresses of the mail servers of disposable-mailbox services (A and AAAA of a domain's MX): the domain
 * names rotate, the server that receives the mail does not. A domain with any MX at one of them is
 * disposable too (`DISPOSABLE_DOMAIN`, detail `DISPOSABLE_MAIL_SERVER`).
 */
export const DISPOSABLE_MX_ADDRESSES: ReadonlyMap<string, string> = new Map([
  ["78.47.124.133", "the 10mail.org family: 10mail.org, emltmp.com, emlpro.com, mailpwr.com, mimimail.me, pickmail.org, freeml.net, mailtowin.com, maximail.vip"],
  ["94.130.108.80", "the 10mail.org family (second server)"],
  ["49.12.18.190", "smtp.is (euploading.com)"],
  ["15.204.213.223", "vomoto.com, blondmail.com"],
  ["178.162.170.166", "Guerrilla Mail"],
  ["178.32.61.35", "1secmail.com"],
]);

/** True when any address of the domain's mail servers is a listed one. */
export function isDisposableMailAddress(addresses: readonly string[]): boolean {
  return addresses.some((address) => DISPOSABLE_MX_ADDRESSES.has(address.trim().toLowerCase()));
}

let publicList: ReadonlySet<string> | undefined;

/** Built on first use: only `SignupDispatch` pays for the hundred thousand names. */
function publicSet(): ReadonlySet<string> {
  publicList ??= new Set([...publicDomains, ...publicWildcards]);
  return publicList;
}

/** True for a name of `names` or any subdomain of one; lower-cased, a trailing dot ignored. */
function underAny(names: ReadonlySet<string>, host: string): boolean {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  for (let start = 0; start < labels.length - 1; start += 1) if (names.has(labels.slice(start).join("."))) return true;
  return false;
}

/** True for a domain of either list or any subdomain of one. */
export function isDisposableDomain(domain: string): boolean {
  return underAny(DISPOSABLE_DOMAINS, domain) || underAny(publicSet(), domain);
}

/**
 * True when any MX of the domain is a disposable-mailbox provider's (or a host under a disposable domain):
 * a fresh domain pointed at the same provider does not pass, and adding a second MX does not hide it.
 */
export function isDisposableExchanger(exchanges: readonly string[]): boolean {
  return exchanges.some((exchange) => underAny(DISPOSABLE_MX_PROVIDERS, exchange) || isDisposableDomain(exchange));
}
