// Where the calls to action go (FL-130, docs/landing-spec.md §9): one constant for Craftech's contact
// page with the UTM parameters of every placement, a new tab without opener or referrer, and the
// sign-up reached by a full page load that keeps only the visit's valid campaign parameters.
import { describe, expect, it } from "vitest";
import { CONTACT_PLACEMENTS, CRAFTECH_CONTACT_URL, EXTERNAL_LINK, SALES_MAILTO, SIGNUP_PATH, contactHref, signupHref } from "./links";

describe("calls to action [FL-130]", () => {
  it("sends every 'Hablemos' to Craftech's contact page with the placement as utm_content", () => {
    expect(CRAFTECH_CONTACT_URL).toBe("https://craftech.io/contact/");
    for (const placement of CONTACT_PLACEMENTS) {
      expect(contactHref(placement)).toBe(`https://craftech.io/contact/?utm_source=legajo-listo&utm_medium=demo&utm_campaign=poc-landing&utm_content=${placement}`);
    }
    expect(CONTACT_PLACEMENTS).toEqual(["header", "closing", "footer", "welcome-failed", "platform", "faq", "welcome-capacity"]);
  });

  it("opens Craftech's site in a new tab with neither opener nor referrer, and offers the sales address", () => {
    expect(EXTERNAL_LINK).toEqual({ target: "_blank", rel: "noopener noreferrer" });
    expect(SALES_MAILTO).toBe("mailto:sales@craftech.io");
  });

  it("keeps the visit's valid utm_* parameters on the way to /signup and nothing else", () => {
    expect(signupHref(new URLSearchParams(""))).toBe(SIGNUP_PATH);
    expect(signupHref(new URLSearchParams("lang=en&utm_source=news&utm_campaign=launch-2026&ref=x"))).toBe("/signup?utm_source=news&utm_campaign=launch-2026");
    expect(signupHref(new URLSearchParams("utm_source=<script>&utm_medium=email"))).toBe("/signup?utm_medium=email");
    expect(signupHref(new URLSearchParams(`utm_term=${"a".repeat(101)}`))).toBe(SIGNUP_PATH);
  });
});
