import { describe, expect, it } from "vitest";
import { browserLang } from "./preferred-lang";

describe("[FL-133] the language of the browser", () => {
  it("is Spanish when any preferred language is Spanish, whatever its region", () => {
    expect(browserLang(["es"])).toBe("es");
    expect(browserLang(["es-AR"])).toBe("es");
    expect(browserLang(["es-419", "en-US"])).toBe("es");
    expect(browserLang(["en-US", "fr", "ES-mx"])).toBe("es");
  });

  it("is English for everything else, and when the browser says nothing", () => {
    expect(browserLang(["en-US"])).toBe("en");
    expect(browserLang(["pt-BR", "fr-FR", "de"])).toBe("en");
    expect(browserLang([])).toBe("en");
  });

  it("does not take a language that only starts with the letters es", () => {
    expect(browserLang(["est"])).toBe("en");
    expect(browserLang(["esp-ES"])).toBe("en");
  });
});
