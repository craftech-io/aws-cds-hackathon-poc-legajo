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
    for (const email of ["a@example.com", "a@example.net", "a@mail.example.org", "a@test.com", "a@x.test.com", "a@empresa.test", "a@box.example", "a@me.localhost", "a@host.invalid", "a@box.local", "a@x.onion", "a@corp.internal", "a@router.home.arpa"]) {
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

  it("suppresses disposable mailboxes and their subdomains, and only those", () => {
    for (const email of ["a@mailinator.com", "a@YOPMAIL.com", "a@x.guerrillamail.com", "a@10minutemail.com", "a@euploading.com"]) {
      expect(domainSuppression(email), email).toBe("DISPOSABLE_DOMAIN");
    }
    for (const email of ["a@mailinatorx.com", "a@yopmailing.com", "a@mailinator.com.ar", "a@contest.com", "a@gmail.com", "a@outlook.com"]) expect(domainSuppression(email), email).toBeUndefined();
  });

  it("suppresses the domains seen in the sign-ups of 2026-11-27, from the repository's own list", () => {
    for (const domain of ["euploading.com", "10mail.org", "emltmp.com", "emlpro.com", "vomoto.com", "blondmail.com", "guerrillamailblock.com", "tempmail.lol", "1secmail.com"]) {
      expect(domainSuppression(`a@${domain}`), domain).toBe("DISPOSABLE_DOMAIN");
    }
  });

  it("suppresses a domain only the public list of disposable-email-domains knows, and its wildcard entries", () => {
    for (const email of ["a@0x01.gq", "a@33m.co", "a@anonbox.net", "a@sub.10mail.tk"]) expect(domainSuppression(email), email).toBe("DISPOSABLE_DOMAIN");
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
    expect(await checkMx("throwaway.example-fict.com", async () => [{ exchange: "mx.smtp.is", priority: 10 }])).toEqual({ status: "DISPOSABLE", via: "MX_NAME" });
    expect(await checkMx("other.example-fict.com", async () => [{ exchange: "mx2.SMTP.IS.", priority: 10 }])).toEqual({ status: "DISPOSABLE", via: "MX_NAME" });
    expect(await checkMx("listed.example-fict.com", async () => [{ exchange: "mx.yopmail.com", priority: 10 }])).toEqual({ status: "DISPOSABLE", via: "MX_NAME" });
    expect(await checkMx("lookalike.example-fict.com", async () => [{ exchange: "mx.notsmtp.is", priority: 10 }])).toEqual({ status: "OK" });
  });

  it("suppresses a new domain by the address of its mail server, and only by a listed one", async () => {
    const mx = async (domain: string) => [{ exchange: `mx.${domain}.`, priority: 10 }];
    const at = (addresses: readonly string[]) => async () => addresses;
    for (const address of ["78.47.124.133", "94.130.108.80", "49.12.18.190", "15.204.213.223", "178.162.170.166", "178.32.61.35"]) {
      expect(await checkMx("nuevo.example-fict.com", mx, 50, at([address])), address).toEqual({ status: "DISPOSABLE", via: "MX_ADDRESS" });
    }
    expect(await checkMx("otro.example-fict.com", mx, 50, at(["203.0.113.25", "2001:db8::25"]))).toEqual({ status: "OK" });
    expect(await checkMx("falla.example-fict.com", mx, 50, () => Promise.reject(new Error("ESERVFAIL")))).toEqual({ status: "OK" });
    expect(await checkMx("lento.example-fict.com", mx, 20, () => new Promise(() => undefined))).toEqual({ status: "OK" });
    expect(await checkMx("throwaway.example-fict.com", async () => [{ exchange: "mx.smtp.is", priority: 10 }], 50, at(["203.0.113.25"]))).toEqual({ status: "DISPOSABLE", via: "MX_NAME" });
  });

  it("suppresses the domains of the same family seen on 2026-11-27 at 12:23 by name too", () => {
    for (const domain of ["mailpwr.com", "mimimail.me", "pickmail.org", "freeml.net", "mailtowin.com", "maximail.vip"]) expect(domainSuppression(`a@${domain}`), domain).toBe("DISPOSABLE_DOMAIN");
  });

  it("a second, ordinary MX does not hide a disposable provider", async () => {
    expect(await checkMx("mixed.example-fict.com", async () => [{ exchange: "mx.mixed.example-fict.com", priority: 10 }, { exchange: "mx.smtp.is", priority: 20 }])).toEqual({ status: "DISPOSABLE", via: "MX_NAME" });
  });
});
