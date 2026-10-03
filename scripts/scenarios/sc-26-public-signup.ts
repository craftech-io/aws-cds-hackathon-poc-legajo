// SC-26 · the public sign-up end to end (docs/test-plan.md §4.5, ADR-0015): Playwright's Chrome against
// the deployed site, where the WAF's silent challenge runs for real, plus the `QaDriver`'s fenced SC-26
// actions (docs/test-plan.md §4.1): the codes are read from the simulated domain's raw mail
// (`signup.readCode`), the lead is inspected without personal data (`lead.inspect`) and every account
// is deleted with the module of `leads:delete` (`lead.purge`), at step 13 and in the cleanup. Mailboxes
// are `qa-signup-<runId>-<key>@sim…`: `a` the main account; `b`, `c`, `d` the refusals. Runs alone,
// after SC-24 and before SC-20; it spends two `signup.start` of the runner's IP (steps 2 and 8).
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { LEGAL_VERSIONS } from "@legajo/shared/legal-versions";
import { copy as consoleCopy } from "../../packages/web/src/copy/console";
import { accountApiRefuses, launchBrowser, tokenPlaces, tourPanel } from "./lib/browser";
import {
  type SignupProfile,
  answerShape,
  apiCall,
  copyOf,
  directForgotPassword,
  directSignUp,
  enterCode,
  logMentions,
  openContext,
  refreshOutcome,
  runPassword,
  sessionTokens,
  signInWith,
  signupAddress,
  signupFromLanding,
  submitSignup,
  watchClientId,
} from "./lib/signup-browser";
import { SITE } from "./lib/site";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";

const KEYS = ["a", "b", "c", "d"] as const;
const UTM = "?utm_source=qa&utm_campaign=sc26";
/** `signup.start` answers in the same time whatever the branch (ADR-0015 §1.2). */
const SAME_TIME_MS = 250;
const NO_MAIL_SEC = 90;

interface Run {
  readonly browser: Browser;
  readonly contexts: BrowserContext[];
  readonly startedAt: number;
  mobile?: Page;
  desktop?: Page;
  clientId?: () => string | undefined;
  password: string;
  durationMs?: number;
  shape?: string;
  idToken?: string;
  firmId?: string;
}

const runOf = (ctx: ScenarioContext): Run => {
  const run = ctx.state.run as Run | undefined;
  ensure(run !== undefined, "the browser is open (step 1)");
  return run;
};
const pageOf = (page: Page | undefined, which: string): Page => {
  ensure(page !== undefined, `the ${which} context is open`);
  return page;
};
const mailOf = (ctx: ScenarioContext, key: string) => signupAddress(ctx.runId, key);

interface Inspected {
  exists: boolean;
  leads: number;
  users: number;
  consents?: { terms: { accepted: boolean; version: string; lang: string; privacyVersion: string }; contact: { accepted: boolean; version: string } };
  language?: string;
  utm?: Record<string, string>;
  signupAt?: string;
  confirmedAt?: string;
  lastLoginAt?: string;
  noticeStatus?: string;
  optionalFields?: string[];
  world: { firmId: string | null; state: string } | null;
}

const inspect = async (ctx: ScenarioContext, key: string): Promise<Inspected> => (await ctx.qa("lead.inspect", { key })) as Inspected;

async function readCode(ctx: ScenarioContext, key: string, kind: "SIGNUP" | "EXISTING" | "FORGOT", afterTs: string): Promise<{ code: string; subject: string; language: string; neutral: { clean: boolean } }> {
  const read = (await ctx.qa("signup.readCode", { key, kind, afterTs, timeoutSec: 120 })) as { code: string; subject: string; language: string; neutral: { clean: boolean } };
  ctx.check(read.neutral.clean, `the ${kind} email of ${key} passes the word check of ADR-0014`);
  return read;
}

/** No account email reaches the mailbox in 90 s. */
async function noMail(ctx: ScenarioContext, key: string, afterTs: string): Promise<void> {
  const answer = await ctx.attempt("signup.readCode", { key, kind: "SIGNUP", afterTs, timeoutSec: NO_MAIL_SEC });
  ctx.check(!answer.ok && answer.error.reason === "NO_ACCOUNT_MAIL", `no account email for ${key} in ${NO_MAIL_SEC} s`);
}

async function open(run: Run, profile: SignupProfile): Promise<Page> {
  const { context, page } = await openContext(run.browser, profile);
  run.contexts.push(context);
  return page;
}

export const sc26 = defineScenario({
  id: "SC-26",
  slug: "sc26",
  title: "The public sign-up end to end",
  suites: ["full"],
  alone: true,
  steps: [
    {
      n: 1,
      title: "mobile-es: the landing's CTA keeps the UTM and /signup loads (the signup WAF rule counts, it does not challenge)",
      flows: ["FL-101", "FL-130"],
      async run(ctx) {
        for (const key of KEYS) await ctx.qa("lead.purge", { key });
        const run: Run = { browser: await launchBrowser(), contexts: [], startedAt: Date.now(), password: runPassword(ctx.runId, "a1") };
        ctx.state.run = run;
        run.mobile = await open(run, "mobile-es");
        run.clientId = watchClientId(run.mobile);
        const url = await signupFromLanding(run.mobile, UTM);
        ctx.check(url.searchParams.get("utm_source") === "qa" && url.searchParams.get("utm_campaign") === "sc26", "/signup keeps the utm_* of the landing");
        await expect(run.mobile.getByRole("heading", { level: 1, name: copyOf("mobile-es").signup.title })).toBeVisible();
      },
    },
    {
      n: 2,
      title: "the form with the consents ticked by hand, a human pause, and the masked email on /signup/verify",
      flows: ["FL-101", "FL-119"],
      async run(ctx) {
        const run = runOf(ctx);
        const page = pageOf(run.mobile, "mobile");
        const sent = await submitSignup(page, copyOf("mobile-es"), { email: mailOf(ctx, "a"), password: run.password, name: "Ana Prueba", company: "Estudio de prueba" });
        run.durationMs = sent.durationMs;
        run.shape = sent.shape;
        ctx.state.afterSignup = sent.sentAt;
        ctx.check(!(await page.locator("body").innerText()).includes(mailOf(ctx, "a")), "the verify page shows the email masked");
      },
    },
    {
      n: 3,
      title: "the code arrives in Spanish, with neutral words",
      flows: ["FL-101", "FL-124"],
      async run(ctx) {
        const read = await readCode(ctx, "a", "SIGNUP", ctx.state.afterSignup as string);
        ctx.check(read.language === "es", "the account email is in Spanish");
        ctx.state.code = read.code;
      },
    },
    {
      n: 4,
      title: "a wrong code leaves 4 attempts; the resend waits 60 s and invalidates the previous code",
      flows: ["FL-102", "FL-103"],
      async run(ctx) {
        const run = runOf(ctx);
        const page = pageOf(run.mobile, "mobile");
        const t = copyOf("mobile-es");
        const first = ctx.state.code as string;
        await enterCode(page, t, first === "000000" ? "999999" : "000000", run.password);
        await expect(page.getByRole("alert")).toContainText(t.verify.errors.attemptsLeft(4));
        const resend = page.getByRole("button", { name: t.verify.resend });
        await expect(resend).toBeDisabled();
        await expect(resend).toBeEnabled({ timeout: 75_000 });
        const resentAt = new Date().toISOString();
        await resend.click();
        const again = await readCode(ctx, "a", "SIGNUP", resentAt);
        ctx.check(again.code !== first, "the resend brings a new code");
        await enterCode(page, t, first, run.password);
        await expect(page.getByRole("alert")).toContainText(t.verify.errors.invalid);
        ctx.state.code = again.code;
      },
    },
    {
      n: 5,
      title: "the code confirms the account and the lead: consents with their versions, language, UTM, notice SENT",
      flows: ["FL-101", "FL-115", "FL-119", "FL-130"],
      async run(ctx) {
        const run = runOf(ctx);
        const page = pageOf(run.mobile, "mobile");
        await enterCode(page, copyOf("mobile-es"), ctx.state.code as string, run.password);
        await page.waitForURL(/\/login\?.*welcome=1/, { timeout: 60_000 });
        const lead = await inspect(ctx, "a");
        ctx.check(lead.leads === 1 && lead.users === 1, "one lead and one user for the mailbox");
        ctx.check(lead.consents?.terms.accepted === true && lead.consents.terms.version === LEGAL_VERSIONS.terms && lead.consents.terms.privacyVersion === LEGAL_VERSIONS.privacy && lead.consents.terms.lang === "es", "terms accepted with the versions in force, in es");
        ctx.check(lead.consents?.contact.accepted === true && lead.consents.contact.version === LEGAL_VERSIONS.contact, "contact accepted with its version");
        ctx.check(lead.language === "es" && lead.utm?.source === "qa" && lead.utm.campaign === "sc26", "language es and the UTM of the landing");
        ctx.check(lead.signupAt !== undefined && lead.confirmedAt !== undefined, "signupAt and confirmedAt");
        await ctx.eventually("the lead's notice SENT", async () => (await inspect(ctx, "a")).noticeStatus === "SENT", 120);
      },
    },
    {
      n: 6,
      title: "sign-in → /welcome → READY ≤ 90 s → the console with the tour; the guest's token has no account scope",
      flows: ["FL-105", "FL-123"],
      async run(ctx) {
        const run = runOf(ctx);
        const page = pageOf(run.mobile, "mobile");
        const signedInAt = new Date().toISOString();
        await signInWith(page, copyOf("mobile-es"), mailOf(ctx, "a"), run.password);
        await page.waitForURL(/\/welcome/, { timeout: 60_000 });
        await page.waitForURL(/\/app\/operations/, { timeout: 90_000 });
        await expect(tourPanel(page)).toBeVisible();
        const lead = await inspect(ctx, "a");
        const slot = Number(/^firm-guest-(\d{2})$/.exec(lead.world?.firmId ?? "")?.[1]);
        ctx.check(slot >= 31 && slot <= 90, "a public slot between 31 and 90");
        ctx.check(lead.lastLoginAt !== undefined && Date.parse(lead.lastLoginAt) >= Date.parse(signedInAt) - 1_000, "lastLoginAt at the sign-in");
        run.firmId = lead.world?.firmId ?? undefined;
        const tokens = await sessionTokens(page);
        run.idToken = tokens.idToken;
        const access = (await tokenPlaces(page)).session?.accessToken;
        ensure(access !== undefined, "the console keeps an access token");
        ctx.check(await accountApiRefuses(access), "Cognito's account API refuses the guest's access token");
        const refused = await apiCall(page, "registry.suppliers.upsert", { name: "Proveedor fuera del cerco", country: "DE", timezone: "Europe/Berlin", language: "en", contacts: ["qa-outside@legajo.demo.craftech.io"] }, { ...(run.idToken === undefined ? {} : { idToken: run.idToken }) });
        ctx.check(refused.reason === "RECIPIENT_NOT_ALLOWED", "a supplier contact outside sim… is refused in a guest world");
      },
    },
    {
      n: 7,
      title: "sign-out lands on the landing's notice; the refresh token no longer renews; the world stays",
      flows: ["FL-108"],
      async run(ctx) {
        const run = runOf(ctx);
        const page = pageOf(run.mobile, "mobile");
        const { refreshToken } = await sessionTokens(page);
        await page.getByRole("button", { name: consoleCopy.account.menu }).click();
        await page.getByRole("button", { name: consoleCopy.app.signOut }).click();
        await page.waitForURL(/\/\?signedOut=1/, { timeout: 30_000 });
        await expect(page.getByRole("status").filter({ hasText: copyOf("mobile-es").login.notices.signedOut })).toBeVisible();
        const clientId = run.clientId?.();
        ensure(refreshToken !== undefined && clientId !== undefined, "the session had a refresh token and the console talked to Cognito");
        ctx.check((await refreshOutcome(clientId, refreshToken)) === "NotAuthorizedException", "the revoked refresh token no longer renews");
        ctx.check((await inspect(ctx, "a")).world?.firmId === run.firmId, "the account keeps its world");
      },
    },
    {
      n: 8,
      title: "desktop-en: the same email again answers the same screen in the same time; EXISTING code in English",
      flows: ["FL-104", "FL-120", "FL-124"],
      async run(ctx) {
        const run = runOf(ctx);
        const page = (run.desktop = await open(run, "desktop-en"));
        const t = copyOf("desktop-en");
        await page.goto(`${SITE}/signup?lang=en`);
        const second = runPassword(ctx.runId, "a2");
        const sent = await submitSignup(page, t, { email: mailOf(ctx, "a"), password: second, jobTitle: "Analista" });
        ctx.check(sent.shape === run.shape && sent.shape !== answerShape(null), "the same answer body as step 2");
        ctx.check(Math.abs(sent.durationMs - (run.durationMs ?? 0)) <= SAME_TIME_MS, `signup.start answered within ±${SAME_TIME_MS} ms of step 2`);
        ctx.check(!((await inspect(ctx, "a")).optionalFields ?? []).includes("jobTitle"), "nothing merges before the code");
        const read = await readCode(ctx, "a", "EXISTING", sent.sentAt);
        ctx.check(read.language === "en", "the 'you already have an account' email is in English");
        await enterCode(page, t, read.code, second);
        await page.waitForURL(/\/login\?.*welcome=1/, { timeout: 60_000 });
        await signInWith(page, t, mailOf(ctx, "a"), run.password);
        await expect(page.getByRole("alert")).toHaveText(t.flowErrors.INVALID_CREDENTIALS);
        await signInWith(page, t, mailOf(ctx, "a"), second);
        await page.waitForURL(/\/(?:welcome|app\/)/, { timeout: 60_000 });
        run.password = second;
        const lead = await inspect(ctx, "a");
        ctx.check(lead.leads === 1 && lead.users === 1 && (lead.optionalFields ?? []).includes("jobTitle"), "still one lead and one user, with step 8's optional field merged after the code");
      },
    },
    {
      n: 9,
      title: "forgot password: the code in the account's language, a new password, sign-in",
      flows: ["FL-107"],
      async run(ctx) {
        const run = runOf(ctx);
        const page = (run.desktop = await open(run, "desktop-en"));
        const t = copyOf("desktop-en");
        await page.goto(`${SITE}/forgot?lang=en`);
        const askedAt = new Date().toISOString();
        await page.getByLabel(t.forgot.email).fill(mailOf(ctx, "a"));
        await page.getByRole("button", { name: t.forgot.submit }).click();
        const read = await readCode(ctx, "a", "FORGOT", askedAt);
        ctx.check(read.language === "es", "the reset email follows the account's locale (es)");
        await page.waitForURL(/\/forgot\/reset/, { timeout: 30_000 });
        const third = runPassword(ctx.runId, "a3");
        await page.getByLabel(t.reset.code).fill(read.code);
        await page.getByLabel(t.reset.password, { exact: true }).fill(third);
        await page.getByRole("button", { name: t.reset.submit }).click();
        await page.waitForURL(/\/login\?.*reset=1/, { timeout: 30_000 });
        await signInWith(page, t, mailOf(ctx, "a"), third);
        await page.waitForURL(/\/(?:welcome|app\/)/, { timeout: 60_000 });
        run.password = third;
      },
    },
    {
      n: 10,
      title: "refusals: no WAF cookie, a batch with signup.*, the honeypot and a direct SignUp leave no mail and no account",
      flows: ["FL-113"],
      async run(ctx) {
        const run = runOf(ctx);
        const since = new Date().toISOString();
        const clean = await run.browser.newContext();
        run.contexts.push(clean);
        const bare = await clean.request.post(`${SITE}/api/signup.start`, { data: { email: mailOf(ctx, "b") } });
        ctx.check(bare.status() === 202 && bare.headers()["x-amzn-waf-action"] === "challenge", "signup.start without the WAF cookie gets the challenge");
        const batch = await apiCall(pageOf(run.mobile, "mobile"), "account.usage,signup.start?batch=1", { 0: {}, 1: { email: mailOf(ctx, "b") } });
        ctx.check(batch.status === 400, "a batch naming signup.* is refused by the BFF");
        await noMail(ctx, "b", since);
        const honeypot = await open(run, "mobile-es");
        await honeypot.goto(`${SITE}/signup`);
        await honeypot.locator("#signup-website").fill("https://qa.legajo.demo.craftech.io", { force: true });
        await submitSignup(honeypot, copyOf("mobile-es"), { email: mailOf(ctx, "c"), password: runPassword(ctx.runId, "c1") });
        await noMail(ctx, "c", since);
        const c = await inspect(ctx, "c");
        ctx.check(c.leads === 0 && c.users === 0, "the honeypot leaves no lead and no user");
        const clientId = run.clientId?.();
        ensure(clientId !== undefined, "the public client id was seen in step 6");
        ctx.check((await directSignUp(clientId, mailOf(ctx, "d"), runPassword(ctx.runId, "d1"))) === "UserLambdaValidationException", "SignUp without a ticket is refused by PreSignUp");
        await noMail(ctx, "d", since);
        ctx.check((await inspect(ctx, "d")).users === 0, "no user for the direct SignUp");
      },
    },
    {
      n: 11,
      title: "the account email quota: the fifth email arrives, the sixth is refused and never sent",
      flows: ["FL-114"],
      async run(ctx) {
        const clientId = runOf(ctx).clientId?.();
        ensure(clientId !== undefined, "the public client id was seen in step 6");
        const fifthAt = new Date().toISOString();
        ctx.check((await directForgotPassword(clientId, mailOf(ctx, "a"))) === "OK", "the fifth account email is accepted");
        await readCode(ctx, "a", "FORGOT", fifthAt);
        const sixthAt = new Date().toISOString();
        ctx.check((await directForgotPassword(clientId, mailOf(ctx, "a"))) !== "OK", "the sixth is refused by the trigger");
        const sixth = await ctx.attempt("signup.readCode", { key: "a", kind: "FORGOT", afterTs: sixthAt, timeoutSec: 120 });
        ctx.check(!sixth.ok, "no sixth email in 120 s: otherwise the CustomEmailSender plan B is needed");
      },
    },
    {
      n: 12,
      title: "a wrong password gets the generic error",
      flows: ["FL-106"],
      async run(ctx) {
        const page = pageOf(runOf(ctx).mobile, "mobile");
        const t = copyOf("mobile-es");
        await page.goto(`${SITE}/login`);
        await signInWith(page, t, mailOf(ctx, "a"), runPassword(ctx.runId, "wrong"));
        await expect(page.getByRole("alert")).toHaveText(t.flowErrors.INVALID_CREDENTIALS);
      },
    },
    {
      n: 13,
      title: "lead.purge: the same generic error, no lead, no user, and the old token finds its world gone",
      flows: ["FL-118"],
      async run(ctx) {
        const run = runOf(ctx);
        const page = pageOf(run.mobile, "mobile");
        const t = copyOf("mobile-es");
        await ctx.qa("lead.purge", { key: "a" });
        await page.goto(`${SITE}/login`);
        await signInWith(page, t, mailOf(ctx, "a"), run.password);
        await expect(page.getByRole("alert")).toHaveText(t.flowErrors.INVALID_CREDENTIALS);
        const gone = await inspect(ctx, "a");
        ctx.check(!gone.exists && gone.users === 0 && gone.world === null, "no lead, no user and no world lease");
        const token = run.idToken;
        const expiresAt = token === undefined ? 0 : (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number }).exp ?? 0;
        if (token === undefined || expiresAt * 1_000 <= Date.now() + 120_000) return ctx.warn("the id token of step 6 expires before the world's destruction can be observed");
        await ctx.eventually("the old token gets GUEST_WORLD_GONE", async () => (await apiCall(page, "account.world", {}, { idToken: token, query: true })).reason === "GUEST_WORLD_GONE", 120);
      },
    },
    {
      n: 14,
      title: "no log group of the app mentions the run's sign-up mailboxes",
      flows: ["FL-121"],
      async run(ctx) {
        ctx.check((await logMentions(`qa-signup-${ctx.runId}`, runOf(ctx).startedAt)) === 0, "no qa-signup-<runId> in the app's logs");
      },
    },
  ],
  async cleanup(ctx) {
    const run = ctx.state.run as Run | undefined;
    for (const key of KEYS) await ctx.attempt("lead.purge", { key });
    for (const context of run?.contexts ?? []) await context.close();
    await run?.browser.close();
  },
});
