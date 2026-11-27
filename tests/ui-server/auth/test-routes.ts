// Routes of the local UI server that exist only here, never in a Lambda (docs/test-plan.md §2): the
// browser's Cognito API the specs route the real endpoint to (`/__cognito`), the last email the pool
// "sent" to an address (its code, never a real mailbox), the last SMS code to a number, the switches of the guest worlds (the
// public slots full, a world destroyed by its lifetime) and the readings of a guest's world that no
// worker produces here (dossier-fixtures.ts). They answer JSON and listen on 127.0.0.1 only.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAIL_BASES } from "@legajo/bff/auth-triggers/custom-message";
import { leadEmailHash } from "@legajo/bff/lib/crypto";
import { LEADS_TABLE } from "@legajo/bff/leads/lead";
import { forgetWindowed } from "@legajo/bff/signup/counters";
import { domainHash } from "@legajo/bff/signup/dispatch";
import { RATE_BASES } from "@legajo/bff/signup/rate-limits";
import { z } from "zod";
import { readAccountWorld } from "@legajo/bff/worlds/guest-slots";
import { guestIdentity } from "@legajo/bff/worlds/world-ids";
import { writeDossierFixtures } from "../dossier-fixtures";
import type { GuestWorlds } from "./guest-world";
import type { BrowserCognito } from "./browser-api";
import type { LocalAccess } from "./access";
import { readBody } from "../lambda-bridge";
import { COGNITO_ROUTE, TEST_PREFIX } from "./routes";


export interface TestRoutesDeps {
  readonly cognito: BrowserCognito;
  readonly access: LocalAccess;
  readonly worlds: GuestWorlds;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

const WorldSwitches = z.object({ email: z.string().min(3), full: z.boolean() }).strict();
const ByEmail = z.object({ email: z.string().min(3) }).strict();
const NewGuest = z.object({ email: z.string().min(3), password: z.string().min(1), automation: z.boolean().default(true) }).strict();
const SignupAge = z.object({ email: z.string().min(3), seconds: z.number().int().min(1).max(3_600) }).strict();

/** `iso` moved `seconds` into the past. */
function earlier(iso: unknown, seconds: number): string | undefined {
  return typeof iso === "string" ? new Date(Date.parse(iso) - seconds * 1000).toISOString() : undefined;
}

async function jsonBody<T>(request: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse((await readBody(request)).toString("utf8") || "{}"));
}

export async function handleTestRoute(request: IncomingMessage, response: ServerResponse, deps: TestRoutesDeps): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://ui-server.local");
  if (url.pathname === COGNITO_ROUTE && request.method === "POST") {
    const answer = await deps.cognito.handle(String(request.headers["x-amz-target"] ?? ""), (await readBody(request)).toString("utf8"));
    response.writeHead(answer.status, { "content-type": "application/x-amz-json-1.1" }).end(JSON.stringify(answer.body));
    return true;
  }
  if (!url.pathname.startsWith(TEST_PREFIX)) return false;
  const route = url.pathname.slice(TEST_PREFIX.length);
  if (route === "email" && request.method === "GET") {
    await deps.access.settled();
    const email = deps.access.pool.lastEmailTo(url.searchParams.get("to") ?? "");
    json(response, email ? 200 : 404, email ? { kind: email.kind, code: email.code, subject: email.subject } : { error: "no email" });
    return true;
  }
  if (route === "sms" && request.method === "GET") {
    // The last SMS code to a number (ADR-0021): the in-memory sender never sends one.
    const code = deps.access.sms.lastCode(url.searchParams.get("to") ?? "");
    json(response, code ? 200 : 404, code ? { code } : { error: "no sms" });
    return true;
  }
  if (route === "notices" && request.method === "GET") {
    await deps.access.settled();
    const email = (url.searchParams.get("email") ?? "").toLowerCase();
    json(response, 200, { count: deps.access.notices.filter((notice) => "text" in notice && typeof notice.text === "string" && notice.text.includes(email)).length });
    return true;
  }
  if (route === "invocations" && request.method === "GET") {
    await deps.access.settled();
    json(response, 200, deps.access.invocations.map((invocation) => invocation.target));
    return true;
  }
  if (route === "lead" && request.method === "GET") {
    await deps.access.settled();
    const emailHash = leadEmailHash(deps.access.deps.keys.leadEmail, url.searchParams.get("email") ?? "");
    const lead = await deps.access.deps.leads.get(emailHash);
    // Before the SMS code the lead is still the sign-up's draft (ADR-0021): the same consents, and `draft`.
    const [draft] = lead === undefined ? await deps.access.deps.client.scan(LEADS_TABLE, { filter: { equals: { entity: "LeadDraft", emailHash } } }) : [];
    const consents = (lead ?? draft) as { consents?: { contact?: { accepted?: boolean } }; language?: string } | undefined;
    json(response, consents ? 200 : 404, consents ? { contact: consents.consents?.contact?.accepted, language: consents.language, draft: lead === undefined } : { error: "no lead" });
    return true;
  }
  if (route === "shared-limits/forget" && request.method === "POST") {
    // The demo-wide counters every spec of a run shares (new sign-ups in total, per email domain, account
    // emails per domain and in total: all test mailboxes share one domain). Their caps are the subject of
    // the unit tests (signup/rate-limits.test.ts, auth-triggers/custom-message.test.ts); a spec forgets
    // them so the specs running side by side do not use up each other's. Per IP and per email stay.
    const { email } = await jsonBody(request, ByEmail);
    const { client, keys, now } = deps.access.deps;
    const domain = domainHash(keys.rate, email);
    await forgetWindowed(client, RATE_BASES.startTotal, ["DAY"], now());
    await forgetWindowed(client, RATE_BASES.startDomain(domain), ["HOUR"], now());
    await forgetWindowed(client, MAIL_BASES.domain(domain), ["HOUR"], now());
    await forgetWindowed(client, MAIL_BASES.total, ["DAY"], now());
    // The demo-wide SMS caps of ADR-0021 (in total and outside the home region) are shared by every spec of the run too.
    await forgetWindowed(client, "RL#SMS#TOTAL", ["DAY"], now());
    await forgetWindowed(client, "RL#SMS#FOREIGN", ["DAY"], now());
    json(response, 200, { forgotten: true });
    return true;
  }
  if (route === "signup-age" && request.method === "POST") {
    // The sign-up of `email` as if `seconds` had gone by (the page's own clock is Playwright's), so a
    // spec sees the resend wait end without waiting it out in real time.
    const { email, seconds } = await jsonBody(request, SignupAge);
    await deps.access.settled();
    const items = await deps.access.deps.client.scan(LEADS_TABLE);
    let aged = 0;
    for (const item of items) {
      if (item.SK !== "PENDING" || item.email !== email.toLowerCase()) continue;
      const lastResendAt = earlier(item.lastResendAt, seconds);
      await deps.access.deps.client.put(LEADS_TABLE, { ...item, startedAt: earlier(item.startedAt, seconds), ...(lastResendAt ? { lastResendAt } : {}) });
      aged += 1;
    }
    json(response, 200, { aged });
    return true;
  }
  if (route === "users" && request.method === "POST") {
    // A public guest that already verified its email (the sign-up itself is auth.spec.ts's), for the
    // specs of the welcome mechanics: its first sign-in gets a world like any visitor's (guest-world.ts).
    const { email, password, automation } = await jsonBody(request, NewGuest);
    const user = await deps.access.pool.addConfirmed({ username: `usr-${randomUUID().replaceAll("-", "").slice(0, 26)}`, email, password, groups: ["GUEST"] });
    // A fixture of the server, not a visitor: marked as automation (ADR-0021 §8), so the welcome specs
    // test the welcome; the SMS code itself is auth.spec.ts's and phone.spec.ts's (`automation: false`).
    if (automation) await deps.access.deps.phones.markAutomation(user.sub, "SCENARIO_RUNNER", deps.access.deps.now());
    json(response, 201, { username: user.username });
    return true;
  }
  if (route === "guest-worlds" && request.method === "POST") {
    const { email, full } = await jsonBody(request, WorldSwitches);
    const user = deps.access.pool.find(email);
    if (user && full) deps.worlds.control.fullFor.add(user.sub);
    if (user && !full) deps.worlds.control.fullFor.delete(user.sub);
    json(response, user ? 200 : 404, { full });
    return true;
  }
  if (route === "guest-worlds/expire" && request.method === "POST") {
    const { email } = await jsonBody(request, ByEmail);
    const user = deps.access.pool.find(email);
    json(response, 200, { expired: user ? await deps.worlds.expire(user.sub) : false });
    return true;
  }
  if (route === "dossier-fixtures" && request.method === "POST") {
    // Readings the UI server has no worker to produce, written in the account's own world (dossier-fixtures.ts).
    const { email } = await jsonBody(request, ByEmail);
    await deps.access.settled();
    await deps.worlds.settled();
    const user = deps.access.pool.find(email);
    const lease = user === undefined ? undefined : await readAccountWorld(deps.worlds.deps.client, user.sub);
    if (lease?.state !== "READY" || lease.firmId === undefined) {
      json(response, user === undefined ? 404 : 409, { error: "no world ready for that account" });
      return true;
    }
    await writeDossierFixtures(deps.worlds.deps.data, { firmId: lease.firmId, clockId: guestIdentity(lease.firmId).clockId });
    json(response, 200, { written: true });
    return true;
  }
  if (route === "revoked" && request.method === "GET") {
    json(response, 200, { count: deps.cognito.revoked.size });
    return true;
  }
  json(response, 404, { error: "unknown test route" });
  return true;
}
