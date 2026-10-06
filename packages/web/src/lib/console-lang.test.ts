import { afterEach, describe, expect, it } from "vitest";
import { copy } from "../copy/console";
import { LANG_STORAGE_KEY } from "../views/auth/lang";
import { activeLang, inLang, setActiveLang } from "./console-lang";
import { initialConsoleLang } from "./preferred-lang";
import { formatDateTime, formatDayMonth, formatNumber, formatReaderValue, formatSimDateTime } from "./format";

const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  setActiveLang("es");
  Reflect.deleteProperty(globalThis, "window");
  if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("[FL-133] the active language of the console", () => {
  it("starts in Spanish and follows setActiveLang in every text it renders", () => {
    expect(activeLang()).toBe("es");
    expect(copy.account.menu).toBe("Mi cuenta");
    setActiveLang("en");
    expect(copy.account.menu).toBe("My account");
    expect(copy.clock.running("11:02")).toBe("live clock until 11:02");
    expect(copy.time.weekdays).toHaveLength(7);
    setActiveLang("es");
    expect(copy.clock.running("11:02")).toBe("reloj en vivo hasta las 11:02");
  });

  it("reads texts in another language without leaving it behind", () => {
    expect(inLang("en", () => copy.app.signOut)).toBe("Sign out");
    expect(copy.app.signOut).toBe("Cerrar sesión");
    expect(() => inLang("en", () => { throw new Error("boom"); })).toThrow("boom");
    expect(activeLang()).toBe("es");
  });

  it("formats dates and numbers in the language, keeping Buenos Aires time", () => {
    const instant = "2026-10-14T13:30:00Z";
    expect(formatSimDateTime(instant)).toBe("mié 14/10 10:30");
    expect(formatDateTime(instant)).toBe("14/10/2026 10:30");
    expect(formatNumber(12_840.5, 1)).toBe("12.840,5");
    expect(formatReaderValue("12,840 kg")).toBe("12.840 kg");
    setActiveLang("en");
    expect(formatSimDateTime(instant)).toBe("Wed 14 Oct 10:30");
    expect(formatDayMonth("2026-10-22T11:00:00Z")).toBe("22 Oct");
    expect(formatDateTime(instant)).toBe("14 Oct 2026 10:30");
    expect(formatNumber(12_840.5, 1)).toBe("12,840.5");
    expect(formatNumber(-1_234_567)).toBe("-1,234,567");
    expect(formatReaderValue("12,840 kg")).toBe("12,840 kg");
    expect(formatReaderValue("1,234.5 kg")).toBe("1,234.5 kg");
    expect(formatReaderValue("not signed")).toBe("not signed");
  });

  it("formats a number in the language it is asked for, whatever the console reads", () => {
    setActiveLang("en");
    expect(formatNumber(12_480, 0, "es")).toBe("12.480");
    setActiveLang("es");
    expect(formatNumber(12_480, 0, "en")).toBe("12,480");
  });
});

describe("[FL-133] the language before the server answers", () => {
  function browser(options: { readonly stored?: string; readonly languages: readonly string[]; readonly storageThrows?: boolean }): void {
    const storage = {
      getItem: (key: string) => {
        if (options.storageThrows) throw new Error("blocked");
        return key === LANG_STORAGE_KEY ? (options.stored ?? null) : null;
      },
    };
    Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { languages: options.languages, language: options.languages[0] ?? "" }, configurable: true });
  }

  it("is the language the visitor picked on the landing or the access screens", () => {
    browser({ stored: "en", languages: ["es-AR"] });
    expect(initialConsoleLang()).toBe("en");
    browser({ stored: "es", languages: ["en-US"] });
    expect(initialConsoleLang()).toBe("es");
  });

  it("is the browser's language when nothing was picked, or storage is blocked", () => {
    browser({ languages: ["es-AR", "en"] });
    expect(initialConsoleLang()).toBe("es");
    browser({ languages: ["en-US"] });
    expect(initialConsoleLang()).toBe("en");
    browser({ languages: ["fr-FR"], storageThrows: true });
    expect(initialConsoleLang()).toBe("en");
    browser({ stored: "klingon", languages: ["en-US"] });
    expect(initialConsoleLang()).toBe("en");
  });
});
