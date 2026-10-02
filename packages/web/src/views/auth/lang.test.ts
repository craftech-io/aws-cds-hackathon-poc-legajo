import { afterEach, describe, expect, it, vi } from "vitest";
import { LANG_STORAGE_KEY, hrefWithLang, readStoredLang, resolveLang, storeLang } from "./lang";

afterEach(() => vi.unstubAllGlobals());

describe("[FL-120] language of the public pages (D-02)", () => {
  it("[FL-120] lets the address win, then the remembered choice, then the browser", () => {
    expect(resolveLang(new URLSearchParams("lang=en"), "es", "es-AR")).toBe("en");
    expect(resolveLang(new URLSearchParams("lang=es"), "en", "en-US")).toBe("es");
    expect(resolveLang(new URLSearchParams("lang=fr"), "en", "es-AR")).toBe("en");
    expect(resolveLang(new URLSearchParams(""), undefined, "en-GB")).toBe("en");
    expect(resolveLang(new URLSearchParams(""), undefined, "pt-BR")).toBe("es");
    expect(resolveLang(new URLSearchParams(""), undefined, undefined)).toBe("es");
  });

  it("[FL-120] remembers the choice, and survives a browser that blocks storage", () => {
    const items = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value) } });
    storeLang("en");
    expect(items.get(LANG_STORAGE_KEY)).toBe("en");
    expect(readStoredLang()).toBe("en");
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(() => storeLang("es")).not.toThrow();
    expect(readStoredLang()).toBeUndefined();
  });

  it("[FL-120] keeps `?lang=en` on the links of the English pages, and the other parameters", () => {
    expect(hrefWithLang("/login", "es")).toBe("/login");
    expect(hrefWithLang("/login", "en")).toBe("/login?lang=en");
    expect(hrefWithLang("/login", "es", new URLSearchParams("lang=en&reset=1"))).toBe("/login?reset=1");
    expect(hrefWithLang("/signup", "en", new URLSearchParams("utm_source=feria"))).toBe("/signup?utm_source=feria&lang=en");
  });
});
