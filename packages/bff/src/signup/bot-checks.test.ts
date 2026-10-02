import { describe, expect, it } from "vitest";
import { SIGNUP_FORM_MAX_SECONDS, SIGNUP_FORM_MIN_SECONDS } from "@legajo/shared/guest-limits";
import { checkMx, domainSuppression, formSuppression } from "./bot-checks";

const STARTED = "2026-10-14T13:30:00.000Z";
const shownBefore = (seconds: number) => new Date(Date.parse(STARTED) - seconds * 1000).toISOString();

describe("[FL-113] honeypot and time (ADR-0015 §3.1)", () => {
  it("lets a person through and suppresses a filled honeypot, a forged token and a form outside 3 s – 2 h", () => {
    expect(formSuppression({ honeypot: false, formShownAt: shownBefore(SIGNUP_FORM_MIN_SECONDS + 5), startedAt: STARTED })).toBeUndefined();
    expect(formSuppression({ honeypot: true, formShownAt: shownBefore(60), startedAt: STARTED })).toBe("HONEYPOT");
    expect(formSuppression({ honeypot: false, startedAt: STARTED })).toBe("FORM_TOKEN");
    expect(formSuppression({ honeypot: false, formShownAt: shownBefore(SIGNUP_FORM_MIN_SECONDS - 1), startedAt: STARTED })).toBe("TOO_FAST");
    expect(formSuppression({ honeypot: false, formShownAt: shownBefore(SIGNUP_FORM_MAX_SECONDS + 1), startedAt: STARTED })).toBe("TOO_SLOW");
  });
});

describe("[FL-114] the email's domain (ADR-0015 §3.2)", () => {
  it("suppresses reserved and special-use domains", () => {
    for (const email of ["a@example.com", "a@mail.example.org", "a@empresa.test", "a@host.invalid", "a@box.local", "a@x.onion", "a@corp.internal", "a@router.home.arpa"]) {
      expect(domainSuppression(email), email).toBe("RESERVED_DOMAIN");
    }
  });

  it("suppresses our own domains but the QaDriver's fenced mailbox", () => {
    for (const email of ["a@legajo.demo.craftech.io", "supplier-x@sim.legajo.demo.craftech.io", "bounce@simulator.amazonses.com", "qa-signup-812@sim.legajo.demo.craftech.io"]) {
      expect(domainSuppression(email), email).toBe("OWN_DOMAIN");
    }
    expect(domainSuppression("qa-signup-812-1-a@sim.legajo.demo.craftech.io")).toBeUndefined();
    expect(domainSuppression("ana@despachos-del-sur.com.ar")).toBeUndefined();
  });

  it("suppresses a domain without MX or with the null MX, and lets a resolver failure through", async () => {
    expect(await checkMx("ok.example-fict.com", async () => [{ exchange: "mx.ok.example-fict.com", priority: 10 }])).toEqual({ status: "OK" });
    expect(await checkMx("null.example-fict.com", async () => [{ exchange: "", priority: 0 }])).toEqual({ status: "NO_MX" });
    expect(await checkMx("dot.example-fict.com", async () => [{ exchange: ".", priority: 0 }])).toEqual({ status: "NO_MX" });
    for (const code of ["ENOTFOUND", "ENODATA"]) {
      expect(await checkMx("none.example-fict.com", async () => Promise.reject(Object.assign(new Error(code), { code })))).toEqual({ status: "NO_MX" });
    }
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED"]) {
      expect(await checkMx("flaky.example-fict.com", async () => Promise.reject(Object.assign(new Error(code), { code })))).toEqual({ status: "UNKNOWN" });
    }
    expect(await checkMx("slow.example-fict.com", () => new Promise(() => undefined), 20)).toEqual({ status: "UNKNOWN" });
  });
});
