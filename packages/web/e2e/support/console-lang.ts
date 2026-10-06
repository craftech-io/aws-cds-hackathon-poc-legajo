// The console opens in the browser's language (docs/adr/0020), and the six projects of the public
// surfaces differ in it: an English project reads the console in English. The specs import the copy
// objects of the console, whose texts follow the language of their own process, so a spec of those
// projects calls this once at the top of its file: the copy it reads is the one the page shows, and
// the process goes back to Spanish after each test (the console project reads Spanish).
import { test } from "@playwright/test";
import { setActiveLang } from "../../src/lib/console-lang.ts";

export function followProjectLanguage(): void {
  test.beforeEach(({}, info) => {
    setActiveLang(/(^|-)en(-|$)/.test(info.project.name) ? "en" : "es");
  });
  test.afterEach(() => {
    setActiveLang("es");
  });
}
