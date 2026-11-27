// `/verify-phone` (ADR-0021; FL-134, FL-135) against the local UI server in the six public projects
// (390 × 844 and 1440 × 900, es and en, reduced motion): an account without a verified number enrols
// one, every later sign-in gets a code at it, shown by its last digits and never changed, and the
// console answers nothing before the code. Codes come from the server's in-memory sender, never from
// a phone. Texts are asserted by their copy key and pass the neutral-surfaces word check.
import { type Page, expect, test } from "@playwright/test";
import { findNeutralHits } from "../../../scripts/lint/neutral-words.ts";
import { copy as consoleCopy } from "../src/copy/console.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { PHONE_COPY } from "../src/views/phone/copy.ts";
import { createVerifiedGuest, forgetSharedLimits, inLang, lastSms, routeCognitoToServer, specLang, testMailbox, testPhone, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { blockExternalRequests } from "./support/assertions";
import { followProjectLanguage } from "./support/console-lang";
import { UI_SERVER_URL } from "./support/env";

followProjectLanguage();

// Fixture password of the in-memory pool: it never leaves this machine.
const PASSWORD = "Clave-de-Prueba-2026!";

let lang: "es" | "en";
let blocked: string[];

test.beforeEach(async ({ page, request }, info) => {
  lang = specLang(info);
  blocked = await blockExternalRequests(page);
  await routeCognitoToServer(page, UI_SERVER_URL);
  await useViewerIp(page, testViewerIp(info));
  await forgetSharedLimits(request, UI_SERVER_URL, testMailbox(info, "limits"));
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

async function signIn(page: Page, email: string): Promise<void> {
  const t = AUTH_COPY[lang];
  await page.goto(inLang("/login", lang));
  await page.getByLabel(t.login.login).fill(email);
  await page.getByLabel(t.login.password, { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: t.login.submit }).click();
  await expect(page).toHaveURL(/\/verify-phone/);
}

test.describe("[FL-134] [FL-135] the SMS code of every sign-in", () => {
  test("[FL-134] [FL-135] enrols a number, refuses the console before the code, and asks again at the next sign-in", async ({ page, request }, info) => {
    const p = PHONE_COPY[lang];
    const email = testMailbox(info, "sms");
    const phone = testPhone(email);
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD, { automation: false });

    await signIn(page, email);
    await expect(page.getByRole("heading", { level: 1, name: p.enrolTitle })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
    expect(findNeutralHits(await page.locator("body").innerText())).toEqual([]);

    // The console answers nothing yet: it sends the session back here.
    await page.goto("/app/operations");
    await expect(page).toHaveURL(/\/verify-phone\?returnTo=/);

    await page.getByLabel(p.phone).fill("11 5555 0101");
    await page.getByRole("button", { name: p.send }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByLabel(p.phone).fill(phone);
    await page.getByRole("button", { name: p.send }).click();
    const code = await lastSms(request, UI_SERVER_URL, phone);
    // Another code only after the countdown.
    await expect(page.getByRole("button", { name: p.resend })).toHaveCount(0);
    await page.getByLabel(p.code).fill(code === "000000" ? "111111" : "000000");
    await page.getByRole("button", { name: p.verify }).click();
    await expect(page.getByText(p.errors.invalid(4))).toBeVisible();
    await page.getByLabel(p.code).fill(code ?? "");
    await page.getByRole("button", { name: p.verify }).click();
    await expect(page).toHaveURL(/\/app\/operations/, { timeout: 30_000 });

    // Another sign-in: the code goes to the verified number, shown by its last four digits.
    await page.getByRole("button", { name: consoleCopy.account.menu }).click();
    await page.getByRole("button", { name: consoleCopy.app.signOut }).click();
    await expect(page).toHaveURL(/\/\?signedOut=1/);
    await signIn(page, email);
    await expect(page.getByRole("heading", { level: 1, name: p.signInTitle })).toBeVisible();
    await expect(page.getByText(p.signInLead(`•••• ${phone.slice(-4)}`))).toBeVisible();
    await expect(page.getByLabel(p.phone)).toHaveCount(0);
    await expect.poll(() => lastSms(request, UI_SERVER_URL, phone)).not.toBe(code);
    const again = await lastSms(request, UI_SERVER_URL, phone);
    await page.getByLabel(p.code).fill(again ?? "");
    await page.getByRole("button", { name: p.verify }).click();
    await expect(page).toHaveURL(/\/welcome|\/app\//, { timeout: 20_000 });
  });
});
