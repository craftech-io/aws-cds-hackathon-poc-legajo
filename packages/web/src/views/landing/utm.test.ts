// Where a visit came from (FL-130, ADR-0015 §2): campaign parameters of at most 100 characters of
// [A-Za-z0-9._~ -] (anything else dropped whole), the referrer reduced to scheme and host and dropped
// when it is our own, kept in sessionStorage without ever throwing, re-checked when read back, and the
// sign-up working the same when storage is blocked.
import { describe, expect, it } from "vitest";
import { ATTRIBUTION_KEY, type AttributionStorage, captureAttribution, parseAttribution, readAttribution, sanitizeReferrer, utmFromSearch } from "./utm";

function memoryStorage(initial: Record<string, string> = {}): AttributionStorage & { readonly data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

const blocked: AttributionStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
};

const HOST = "legajo.demo.craftech.io";

describe("campaign parameters [FL-130]", () => {
  it("keeps the five utm_* parameters that pass the rules and drops the rest whole", () => {
    expect(utmFromSearch(new URLSearchParams("utm_source=newsletter&utm_medium=email&utm_campaign=Q4 launch&utm_term=a.b~c_d&utm_content=hero"))).toEqual({
      source: "newsletter",
      medium: "email",
      campaign: "Q4 launch",
      term: "a.b~c_d",
      content: "hero",
    });
    expect(utmFromSearch(new URLSearchParams("utm_source=a%2Fb&utm_medium=%3Cb%3E&utm_campaign=ok"))).toEqual({ campaign: "ok" });
    expect(utmFromSearch(new URLSearchParams(`utm_source=${"x".repeat(100)}`))).toEqual({ source: "x".repeat(100) });
    expect(utmFromSearch(new URLSearchParams(`utm_source=${"x".repeat(101)}`))).toBeUndefined();
    expect(utmFromSearch(new URLSearchParams("utm_source=&gclid=123&utm_other=1"))).toBeUndefined();
  });

  it("reduces the referrer to scheme and host and drops our own host, other schemes and overlong origins", () => {
    expect(sanitizeReferrer("https://news.example.com/a/b?c=d#e", HOST)).toBe("https://news.example.com");
    expect(sanitizeReferrer("https://legajo.demo.craftech.io/legal/terms.html", HOST)).toBeUndefined();
    expect(sanitizeReferrer("android-app://com.example", HOST)).toBeUndefined();
    expect(sanitizeReferrer("not a url", HOST)).toBeUndefined();
    expect(sanitizeReferrer(`https://${"a".repeat(200)}.com/`, HOST)).toBeUndefined();
  });
});

describe("attribution in sessionStorage [FL-130]", () => {
  it("stores what a load brings and keeps it through a load that brings nothing (the full page load of /signup)", () => {
    const storage = memoryStorage();
    captureAttribution({ search: new URLSearchParams("utm_source=news"), referrer: "https://news.example.com/x", host: HOST, storage });
    expect(readAttribution(storage)).toEqual({ utm: { source: "news" }, referrer: "https://news.example.com" });
    captureAttribution({ search: new URLSearchParams(""), referrer: `https://${HOST}/`, host: HOST, storage });
    expect(readAttribution(storage)).toEqual({ utm: { source: "news" }, referrer: "https://news.example.com" });
  });

  it("replaces the whole attribution with the last visit that brings one", () => {
    const storage = memoryStorage();
    captureAttribution({ search: new URLSearchParams("utm_source=a&utm_medium=b"), referrer: "", host: HOST, storage });
    captureAttribution({ search: new URLSearchParams(""), referrer: "https://other.example.org/", host: HOST, storage });
    expect(readAttribution(storage)).toEqual({ referrer: "https://other.example.org" });
  });

  it("re-checks what comes back from storage and never trusts it as written", () => {
    expect(parseAttribution(JSON.stringify({ utm: { source: "ok", medium: "<x>", extra: "y" }, referrer: "javascript:alert(1)" }))).toEqual({ utm: { source: "ok" } });
    expect(parseAttribution("{not json")).toEqual({});
    expect(parseAttribution(null)).toEqual({});
    const storage = memoryStorage({ [ATTRIBUTION_KEY]: JSON.stringify({ referrer: "https://ok.example.com" }) });
    expect(readAttribution(storage)).toEqual({ referrer: "https://ok.example.com" });
  });

  it("never throws when storage is blocked: the sign-up goes on without attribution", () => {
    expect(() => captureAttribution({ search: new URLSearchParams("utm_source=a"), referrer: "", host: HOST, storage: blocked })).not.toThrow();
    expect(readAttribution(blocked)).toEqual({});
    expect(readAttribution(undefined)).toEqual({});
  });
});
