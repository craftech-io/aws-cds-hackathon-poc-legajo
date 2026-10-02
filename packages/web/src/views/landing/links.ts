// Where the landing's calls to action go (docs/landing-spec.md §9, ADR-0016 §1). "Probar la demo" opens
// the sign-up with a full page load (an `<a href>` the router never intercepts, so WAF can challenge the
// document, ADR-0015 §3.3) and keeps the campaign parameters; "Hablemos" opens Craftech's public
// contact page in a new tab, with UTM parameters that say which button was used. That address is this
// single constant: if the contact page moves, change it here and check it again with `curl -sI`.
import { utmFromSearch, UTM_KEYS } from "./utm";

export const CRAFTECH_CONTACT_URL = "https://craftech.io/contact/";
export const SALES_EMAIL = "sales@craftech.io";
export const SALES_MAILTO = `mailto:${SALES_EMAIL}`;

export const SIGNUP_PATH = "/signup";
export const SIGN_IN_PATH = "/login";

/** Every place a "Hablemos" button lives, which travels as `utm_content`. */
export const CONTACT_PLACEMENTS = ["header", "closing", "footer", "welcome-failed", "platform", "faq", "welcome-capacity"] as const;
export type ContactPlacement = (typeof CONTACT_PLACEMENTS)[number];

const CONTACT_UTM = { utm_source: "legajo-listo", utm_medium: "demo", utm_campaign: "poc-landing" } as const;

/** Craftech's contact page for a button at `placement`. */
export function contactHref(placement: ContactPlacement): string {
  return `${CRAFTECH_CONTACT_URL}?${new URLSearchParams({ ...CONTACT_UTM, utm_content: placement }).toString()}`;
}

/** `/signup`, carrying the visit's valid `utm_*` parameters (and nothing else) from the current address. */
export function signupHref(search: URLSearchParams): string {
  const utm = utmFromSearch(search);
  if (!utm) return SIGNUP_PATH;
  const kept = new URLSearchParams();
  for (const key of UTM_KEYS) {
    const value = utm[key];
    if (value !== undefined) kept.set(`utm_${key}`, value);
  }
  return `${SIGNUP_PATH}?${kept.toString()}`;
}

/** Attributes of every link that leaves for Craftech's site. */
export const EXTERNAL_LINK = { target: "_blank", rel: "noopener noreferrer" } as const;
