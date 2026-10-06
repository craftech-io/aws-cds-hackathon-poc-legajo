import { afterEach, describe, expect, it, vi } from "vitest";
import { LANG_STORAGE_KEY, browserLang } from "./preferred-lang";

afterEach(() => vi.unstubAllGlobals());

describe("[FL-120] the browser's language", () => {
  it("[FL-120] is Spanish when the browser lists any Spanish variant, in any position", () => {
    expect(browserLang(["es"])).toBe("es");
    expect(browserLang(["es-AR", "en-US"])).toBe("es");
    expect(browserLang(["ES-419"])).toBe("es");
    expect(browserLang(["en-US", "es"])).toBe("es");
  });

  it("[FL-120] is English for everything else, including no preference at all", () => {
    expect(browserLang(["en-GB"])).toBe("en");
    expect(browserLang(["pt-BR", "fr"])).toBe("en");
    expect(browserLang(["esperanto"])).toBe("en");
    expect(browserLang([])).toBe("en");
  });

  it("[FL-120] reads navigator.languages, and falls back to navigator.language", () => {
    vi.stubGlobal("navigator", { languages: ["es-MX", "en"], language: "es-MX" });
    expect(browserLang()).toBe("es");
    vi.stubGlobal("navigator", { languages: [], language: "es-CL" });
    expect(browserLang()).toBe("es");
    vi.stubGlobal("navigator", { languages: [], language: "" });
    expect(browserLang()).toBe("en");
  });

  it("[FL-120] keeps one storage key for the visitor's explicit choice", () => {
    expect(LANG_STORAGE_KEY).toBe("legajo.lang");
  });
});
