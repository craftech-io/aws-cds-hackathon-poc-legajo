// Local flows of the guest worlds (docs/flows-catalog.md, area J; ADR-0015 §4): the first sign-in of a
// public guest creates its world with the real factory over the seed's `guest` template (`WorldJanitor
// GUEST_CREATE` in process), the world expires on the real clock and comes back, the public slots run out,
// the world's quotas cut turns and sends inside the stage's pipeline and worker, and nothing of a guest
// world reaches a real party. Real time is the machine's at the start of each test (id tokens are checked
// against it) and only the test moves it.
import { GUEST_SLOTS } from "@legajo/shared/guest-limits";
import { QuotaExceededError } from "@legajo/shared/errors";
import { consumeQuota } from "@legajo/bff/worlds/guest-quotas";
import { leasePublicSlot, readAccountWorld, releaseSlot } from "@legajo/bff/worlds/guest-slots";
import { createWorld } from "@legajo/bff/worlds/factory";
import { leadEmailHash } from "@legajo/bff/lib/crypto";
import { describe, expect, it } from "vitest";
import { useFlowWorld } from "./support/lifecycle";
import { READ_DOSSIER, READ_OPERATION, EMAIL_DOCS_REQUEST } from "./support/plans";
import { createPublicEdge, type PublicEdge } from "./support/public";
import type { FlowWorld } from "./support/world";

const worlds = useFlowWorld();
const EMAIL = "martin.sosa@estudio-ficticio.com.ar";
const PUBLIC_SLOTS = GUEST_SLOTS.public.last - GUEST_SLOTS.public.first + 1;

async function edge(plans: Parameters<typeof worlds.open>[0] = {}) {
  const flow = await worlds.open(plans, { realNow: new Date().toISOString() });
  return { flow, edge: createPublicEdge(flow) };
}

/** The first sign-in: `account.ensureWorld`, the `GUEST_CREATE` it handed on, and a token with the world. */
async function firstSignIn(api: PublicEdge, email: string): Promise<{ readonly ensure: unknown; readonly world: unknown; readonly token: string }> {
  const ensure = await api.api("POST", "account.ensureWorld", {}, { token: await api.tokenOf(email) });
  await api.settle();
  const token = await api.tokenOf(email);
  const world = await api.api("GET", "account.world", {}, { token });
  return { ensure: ensure.data, world: world.data, token };
}

/** Every public slot leased by other accounts. */
async function fillPublicSlots(flow: FlowWorld): Promise<string[]> {
  const leases: string[] = [];
  for (let slot = 0; slot < PUBLIC_SLOTS; slot += 1) {
    const lease = await leasePublicSlot(flow.stores.client, { sub: `sub-otra-cuenta-${slot}`, leaseId: `lease-otra-${slot}`, now: flow.realNow(), random: () => 0 });
    if (lease !== undefined) leases.push(String(lease.nn));
  }
  return leases;
}

async function exhaust(flow: FlowWorld, clockId: string, kind: "AGENT_TURNS" | "OUTBOUND_EMAILS"): Promise<void> {
  for (let unit = 0; unit < 10_000; unit += 1) {
    try {
      await consumeQuota({ client: flow.stores.client, now: flow.realNow, log: flow.stage.log }, clockId, kind);
    } catch (error) {
      if (error instanceof QuotaExceededError) return;
      throw error;
    }
  }
  throw new Error(`the ${kind} quota of ${clockId} never ran out`);
}

describe("guest world flows", () => {
  it("[FL-105] the first sign-in of a public guest: ensureWorld → GUEST_CREATE → READY → a token with firmId → operations.list of the new world", async () => {
    const { edge: api } = await edge();
    await api.signUp(EMAIL);

    const first = await firstSignIn(api, EMAIL);

    expect(first.ensure).toMatchObject({ state: "CREATING" });
    expect(first.world).toMatchObject({ state: "READY" });
    const firmId = (first.world as { firmId: string }).firmId;
    expect(firmId).toMatch(/^firm-guest-(3[1-9]|[4-8]\d|90)$/);
    const listed = await api.api("GET", "operations.list", {}, { token: first.token });
    expect(listed.status).toBe(200);
    const { operations, clockId } = listed.data as { clockId: string; operations: Array<{ operationNumber: string; clockId: string }> };
    expect(clockId).toBe(`GUEST#${firmId}`);
    expect(operations.map((operation) => operation.operationNumber)).toContain("4471");
    expect(operations.every((operation) => operation.clockId === clockId)).toBe(true);
  });

  it("[FL-109] the public world expires on the real clock (idle TTL) and the next sign-in builds it again from the template, with nothing of the old one", async () => {
    const { flow, edge: api } = await edge();
    const user = await api.signUp(EMAIL);
    const before = await firstSignIn(api, EMAIL);
    const oldClock = `GUEST#${(before.world as { firmId: string }).firmId}`;
    const oldEpoch = (await flow.data.world.getClock(oldClock)).worldEpoch;

    flow.advanceReal(25 * 3_600_000);
    await api.access.invoker.invoke("WorldJanitor", { kind: "GUEST_SWEEP" });
    await api.settle();

    expect((await readAccountWorld(flow.stores.client, user.sub))?.state).toBe("DESTROYED");
    expect((await api.api("GET", "operations.list", {}, { token: before.token })).status).toBe(403);
    const again = await firstSignIn(api, EMAIL);
    expect(again.world).toMatchObject({ state: "READY" });
    const newClock = `GUEST#${(again.world as { firmId: string }).firmId}`;
    const clock = await flow.data.world.getClock(newClock);
    expect(newClock === oldClock ? clock.worldEpoch > oldEpoch : clock.worldEpoch >= 1).toBe(true);
    const listed = (await api.api("GET", "operations.list", {}, { token: again.token })).data as { operations: Array<{ operationId: string; dossierStatus: string }> };
    for (const operation of listed.operations.filter((candidate) => candidate.operationId.startsWith("op-4471"))) {
      expect(operation.dossierStatus).toBe("OPEN");
      expect((await flow.messages(operation.operationId)).filter((message) => message.direction === "OUT" && Date.parse(message.sentAtReal) > Date.parse(new Date(flow.realNow().getTime() - 3_600_000).toISOString()))).toEqual([]);
    }
  });

  it("[FL-110] with every public slot taken, ensureWorld answers CAPACITY and creates nothing; once a slot is free the next call creates the world", async () => {
    const { flow, edge: api } = await edge();
    await api.signUp(EMAIL);
    const taken = await fillPublicSlots(flow);
    expect(taken).toHaveLength(PUBLIC_SLOTS);

    const full = await firstSignIn(api, EMAIL);

    expect(full.world).toMatchObject({ state: "CAPACITY" });
    expect(api.invoked.filter((call) => call.target === "WorldJanitor" && call.payload.kind === "GUEST_CREATE")).toEqual([]);
    await releaseSlot(flow.stores.client, Number(taken[0]), "lease-otra-0", flow.realNow());
    flow.advanceReal(21 * 60_000);

    const freed = await firstSignIn(api, EMAIL);

    expect(freed.world).toMatchObject({ state: "READY", firmId: `firm-guest-${taken[0]}` });
  });

  it("[FL-132] a confirmed sign-up while the demo is full keeps its lead; the first sign-in answers CAPACITY and the retry after a slot frees creates exactly one world", async () => {
    const { flow, edge: api } = await edge();
    const taken = await fillPublicSlots(flow);
    const user = await api.signUp(EMAIL);

    expect(await api.access.leads.get(leadEmailHash(api.access.keys.leadEmail, EMAIL))).toBeDefined();
    expect((await firstSignIn(api, EMAIL)).world).toMatchObject({ state: "CAPACITY" });
    await releaseSlot(flow.stores.client, Number(taken[1]), "lease-otra-1", flow.realNow());
    flow.advanceReal(21 * 60_000);

    const retried = await firstSignIn(api, EMAIL);
    await firstSignIn(api, EMAIL);

    expect(retried.world).toMatchObject({ state: "READY" });
    expect(api.invoked.filter((call) => call.target === "WorldJanitor" && call.payload.kind === "GUEST_CREATE")).toHaveLength(1);
    expect((await readAccountWorld(flow.stores.client, user.sub))?.state).toBe("READY");
  });

  it("[FL-111] a guest world that spends its outbound emails and its turns: the send is denied by CP-WORLD-QUOTA inside the turn, and once the turns run out a milestone opens none", async () => {
    const { flow } = await edge({ "4471": { MILESTONE: [{ steps: [READ_OPERATION, READ_DOSSIER, EMAIL_DOCS_REQUEST], note: "Pedí al proveedor." }] } });
    await createWorld({ kind: "GUEST", firmId: "firm-guest-41" }, flow.worlds);
    const clockId = "GUEST#firm-guest-41";
    const operationId = (await flow.data.operations.listOperations("firm-guest-41", { clockId })).find((operation) => operation.operationNumber === "4471")?.operationId ?? "";

    // 09:30 in Qingdao: the request would go out now, if the world had emails left.
    await flow.advance({ to: "2026-10-14T22:30:00-03:00" }, clockId);
    await exhaust(flow, clockId, "OUTBOUND_EMAILS");
    await flow.fire(operationId, "DOCS_REQUEST");

    const [turn] = flow.harness.turns;
    expect(turn?.envelope.event.operation).toBe("4471");
    expect(turn?.calls[2]?.output).toMatchObject({ ok: false, error: { code: "POLICY_DENIED", reason: "QUOTA_EXCEEDED" } });
    expect((await flow.data.audit.listByOperation(operationId)).some((row) => row.decision === "DENY" && JSON.stringify(row).includes("CP-WORLD-QUOTA"))).toBe(true);
    expect(flow.aws.sesMessages).toEqual([]);

    await exhaust(flow, clockId, "AGENT_TURNS");
    await flow.fire(operationId, "FOLLOWUP");

    expect(flow.harness.turns).toHaveLength(1);
  });

  it("[FL-123] an escalation in a guest world reaches the demo mailbox of its own firm, and no real transport receives anything", async () => {
    const { flow } = await edge();
    await createWorld({ kind: "GUEST", firmId: "firm-guest-41" }, flow.worlds);
    const clockId = "GUEST#firm-guest-41";
    const operation = (await flow.data.operations.listOperations("firm-guest-41", { clockId })).find((candidate) => candidate.operationNumber === "4478");

    await flow.fire(operation?.operationId ?? "", "ESCALATION");

    const firm = await flow.data.firms.getFirm("firm-guest-41");
    expect(firm.mailboxAddress).toMatch(/@sim\.legajo\.demo\.craftech\.io$/);
    expect((await flow.data.conversations.listMailbox(firm.mailboxAddress)).some((message) => message.operationId === operation?.operationId)).toBe(true);
    expect(flow.aws.whatsappSent).toEqual([]);
    expect(flow.aws.sesMessages.flatMap((sent) => sent.input.Destination?.ToAddresses ?? []).every((address) => address.endsWith("@sim.legajo.demo.craftech.io"))).toBe(true);
    const parties = await flow.data.parties.listImporters("firm-guest-41", { clockId });
    expect(parties.every((importer) => importer.synthetic === true)).toBe(true);
  });
});
