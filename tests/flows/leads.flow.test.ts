// Local flows of the leads (docs/flows-catalog.md, area J; ADR-0015 §5 and §6): the notice to Craftech
// and its retry by the hourly sweep, the operator's scripts (`leads:export`, `leads:optout`,
// `leads:delete`) over the same stores, the sweep that finishes half-done sign-ups, and the rule that a
// lead's data never leaves `Leads`. Everything runs on the public edge of the local world
// (support/public.ts); the scripts are called as functions with the operator's arguments.
import { leadEmailHash } from "@legajo/bff/lib/crypto";
import { describe, expect, it } from "vitest";
import { buildExport } from "../../scripts/leads/export";
import { runDelete } from "../../scripts/leads/delete";
import type { LeadScriptDeps } from "../../scripts/leads/common";
import { runOptout } from "../../scripts/leads/optout";
import { useFlowWorld } from "./support/lifecycle";
import { LOCAL_NOTICE_TO, createPublicEdge, type PublicEdge } from "./support/public";
import { sesEventOf } from "./support/stage/mailroom";

const worlds = useFlowWorld();

async function edge() {
  const flow = await worlds.open({}, { realNow: new Date().toISOString() });
  return { flow, edge: createPublicEdge(flow) };
}

const EMAIL = "lucia.romero@estudio-ficticio.com.ar";
const silent = () => undefined;

function scriptDeps(api: PublicEdge): LeadScriptDeps {
  const { access } = api;
  return { client: access.client, leads: access.leads, signups: access.signups, cognito: access.cognito, invoker: access.invoker, leadEmailKey: access.keys.leadEmail, now: access.now };
}

const leadOf = (api: PublicEdge, email: string) => api.access.leads.get(leadEmailHash(api.access.keys.leadEmail, email));
const notices = (flow: Awaited<ReturnType<typeof edge>>["flow"]) => flow.aws.sesMessages.filter((sent) => sent.input.Destination?.ToAddresses?.includes(LOCAL_NOTICE_TO));

describe("lead flows", () => {
  it("[FL-115] a confirmed sign-up sends one notice to Craftech; when SES fails the lead stays PENDING and the hourly sweep sends it", async () => {
    const { flow, edge: api } = await edge();
    api.sesUp = false;

    await api.signUp(EMAIL);

    expect((await leadOf(api, EMAIL))?.noticeStatus).toBe("PENDING");
    expect(notices(flow)).toEqual([]);
    api.sesUp = true;
    flow.advanceReal(11 * 60_000);

    await api.access.invoker.invoke("WorldJanitor", { kind: "GUEST_SWEEP" });
    await api.settle();

    expect((await leadOf(api, EMAIL))?.noticeStatus).toBe("SENT");
    expect(notices(flow)).toHaveLength(1);
  });

  it("[FL-116] after a bounce of the lead's email the export shows emailStatus BOUNCED, and --contactable leaves it out", async () => {
    const { flow, edge: api } = await edge();
    await api.signUp(EMAIL);
    await api.signUp("otro.lead@estudio-ficticio.com.ar", { viewer: "198.51.100.70:44000" });

    await flow.entries.channelEvent(sesEventOf({ messageId: "account-mail-0002", input: { FromEmailAddress: "no-reply@legajo.demo.craftech.io", Destination: { ToAddresses: [EMAIL] }, Content: {} } }, "Bounce", flow.realNow()));

    const all = await buildExport(scriptDeps(api), { contactable: false });
    const line = all.csv.split("\n").find((row) => row.includes(EMAIL));
    expect(line).toContain("BOUNCED");
    expect(all.rows).toBe(2);
    const contactable = await buildExport(scriptDeps(api), { contactable: true });
    expect(contactable.csv).not.toContain(EMAIL);
    expect(contactable.csv).toContain("otro.lead@estudio-ficticio.com.ar");
  });

  it("[FL-117] withdrawing the contact consent removes the lead from the contactable export; signing in still works", async () => {
    const { edge: api } = await edge();
    await api.signUp(EMAIL, { contact: true });

    expect(await runOptout(scriptDeps(api), ["--email", EMAIL], silent)).toBe(true);

    expect((await leadOf(api, EMAIL))?.consents.contact.accepted).toBe(false);
    expect((await buildExport(scriptDeps(api), { contactable: true })).csv).not.toContain(EMAIL);
    expect(await api.api("GET", "account.session", {}, { token: await api.tokenOf(EMAIL) })).toMatchObject({ status: 200 });
  });

  it("[FL-118] deleting a lead on request removes its account and its world: no sign-in, the old token gets 403, nothing of it in Leads or Runtime, and a new sign-up starts from zero", async () => {
    const { flow, edge: api } = await edge();
    const user = await api.signUp(EMAIL);
    const token = await api.tokenOf(EMAIL);
    await api.api("POST", "account.ensureWorld", {}, { token });
    await api.settle();
    const withWorld = await api.tokenOf(EMAIL);
    expect(await api.api("GET", "operations.list", {}, { token: withWorld })).toMatchObject({ status: 200 });

    await runDelete(scriptDeps(api), ["--email", EMAIL, "--yes"], async () => true, silent);
    await api.settle();

    expect([...api.access.cognito.users.values()].some((candidate) => candidate.email === EMAIL)).toBe(false);
    expect(await leadOf(api, EMAIL)).toBeUndefined();
    expect((await api.api("GET", "operations.list", {}, { token: withWorld })).status).toBe(403);
    const hash = leadEmailHash(api.access.keys.leadEmail, EMAIL);
    const remaining = JSON.stringify(["Runtime", "Firms", "Operations", "Parties"].map((table) => flow.stores.client.dump(table as "Runtime")));
    expect(remaining).not.toContain(hash);
    expect(remaining).not.toContain(EMAIL);
    expect(remaining).not.toContain(`GUESTWORLD#${user.sub}`);

    const again = await api.signUp(EMAIL, { viewer: "198.51.100.71:44001" });
    expect(again.sub).not.toBe(user.sub);
  });

  it("[FL-121] a sign-up, a sign-in, the notice and the deletion leave no lead data in logs, AuditLog or metrics", async () => {
    const { flow, edge: api } = await edge();
    await api.signUp(EMAIL, { viewer: "198.51.100.72:44002" });
    const token = await api.tokenOf(EMAIL);
    await api.api("GET", "account.session", {}, { token });
    await runDelete(scriptDeps(api), ["--email", EMAIL, "--yes"], async () => true, silent);
    await api.settle();

    const outsideLeads = JSON.stringify([...flow.logs, ...(["AuditLog", "LegajoMetrics", "Runtime"] as const).map((table) => flow.stores.client.dump(table))]);
    for (const value of [EMAIL, "lucia.romero", "estudio-ficticio.com.ar"]) expect(outsideLeads).not.toContain(value);
  });

  it("[FL-122] a sign-up cut right after ConfirmSignUp is finished by the hourly sweep within the hour; an EXISTING_GUEST form never confirmed is never finished", async () => {
    const { flow, edge: api } = await edge();
    const started = await api.startSignup(EMAIL);
    api.failLeadWrites = 1;

    const cut = await api.confirm(started.signupId, EMAIL);

    expect(cut.status).toBe(200);
    expect([...api.access.cognito.users.values()].find((candidate) => candidate.email === EMAIL)?.status).toBe("CONFIRMED");
    expect(await leadOf(api, EMAIL)).toBeUndefined();
    flow.advanceReal(30 * 60_000);

    await api.access.invoker.invoke("WorldJanitor", { kind: "GUEST_SWEEP" });
    await api.settle();

    const finished = await leadOf(api, EMAIL);
    expect(finished?.confirmedAt).toBeDefined();
    expect([...api.access.cognito.users.values()].find((candidate) => candidate.email === EMAIL)?.groups).toEqual(["GUEST"]);

    const existing = await api.startSignup(EMAIL, { contact: false, viewer: "198.51.100.73:44003" });
    expect((await api.access.signups.get(existing.signupId, api.access.now()))?.branch).toBe("EXISTING_GUEST");
    flow.advanceReal(61 * 60_000);
    await api.access.invoker.invoke("WorldJanitor", { kind: "GUEST_SWEEP" });
    await api.settle();

    expect((await api.access.signups.get(existing.signupId, api.access.now()))?.verifiedAt).toBeUndefined();
    expect((await leadOf(api, EMAIL))?.consents).toEqual(finished?.consents);
  });
});
