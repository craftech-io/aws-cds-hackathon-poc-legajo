// FL-123 and ADR-0015 §4: a guest operates only on synthetic data. In a guest world (`GUEST#*`) the
// pipeline's WhatsApp always takes the simulated transport, even in a `live` stage; the SYSTEM profile
// writes only to the simulated mailboxes and SES's simulator, never to a registered demo recipient nor
// to any other domain; and every email counts in the world's quota, whose end is a `DENY` audited
// under `CP-WORLD-QUOTA` and `QUOTA_EXCEEDED` to the caller.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { beforeEach, describe, expect, it } from "vitest";
import { GUEST_QUOTAS } from "@legajo/shared/guest-limits";
import { createLogger } from "../lib/log";
import { consumeQuota } from "../worlds/guest-quotas";
import { sendOutbound } from "./pipeline";
import { emailFence } from "./recipient-fence";
import { demoPhoneMatcher, whatsappRouteFor } from "./routes";
import { DEMO_RECIPIENT, FRI_10_QINGDAO, GUEST_CLOCK, REAL_NOW, THU_10_AR, outboundWorld, type OutboundWorld } from "./testing";
import type { OutboundRequest } from "./types";

const GUEST_MAILBOX = "g41-supplier-qingdao@sim.legajo.demo.craftech.io";
const TEXT = "Hello, for invoice QBT-2026-0917 we still need the packing list. Thank you.";

let world: OutboundWorld;

beforeEach(async () => {
  world = await outboundWorld({ demoRecipients: [DEMO_RECIPIENT] });
});

function guestEmail(operationId: string, turnId: string): OutboundRequest {
  return { operationId, channel: "EMAIL", counterpart: "SUPPLIER", kind: "REPLY", author: "AGENT", textSource: "MODEL", trigger: "SUPPLIER_EMAIL", turnId, eventAtSim: FRI_10_QINGDAO, text: TEXT };
}

describe("[FL-123] WhatsApp of a guest world", () => {
  it("takes the simulated transport even when the stage runs live", async () => {
    const transports = { mode: () => "live" as const, simulated: () => ({ name: "simulated" }) as never, live: () => ({ transport: { name: "live" } as never, phoneNumberId: "1098765432109876" }), isLivePhone: demoPhoneMatcher(() => ["+5491100000001"]) };
    expect(whatsappRouteFor(GUEST_CLOCK, "+5491100000001", transports)).toMatchObject({ mode: "simulated", from: "simulated", transport: { name: "simulated" } });
    expect(whatsappRouteFor("GLOBAL#firm-delta", "+54 9 11 0000-0001", transports)).toMatchObject({ mode: "live", from: "1098765432109876", transport: { name: "live" } });
  });

  it("keeps the phone simulator for every importer that is not a demo phone, in a live stage", () => {
    const transports = { mode: () => "live" as const, simulated: () => ({ name: "simulated" }) as never, live: () => ({ transport: { name: "live" } as never, phoneNumberId: "1098765432109876" }), isLivePhone: demoPhoneMatcher(() => ["+5491100000001"]) };
    expect(whatsappRouteFor("GLOBAL#firm-delta", "+5491155500123", transports)).toMatchObject({ mode: "simulated", transport: { name: "simulated" } });
    expect(whatsappRouteFor("GLOBAL#firm-delta", undefined, transports)).toMatchObject({ mode: "simulated" });
  });

  it("never reaches the live transport from a guest operation", async () => {
    world.setWhatsAppMode("live");
    const guest = await world.guestOperation(GUEST_MAILBOX);
    const turnId = await world.turn([{ tool: "get_dossier", output: { firmName: "Estudio Delta", operationNumber: "4490", vessel: "Austral Aurora", etaText: "22/10", missingDocuments: "packing list" } }]);
    const request: OutboundRequest = { operationId: guest.operationId, channel: "WHATSAPP", kind: "DOCS_REQUEST", author: "AGENT", textSource: "MODEL", trigger: "MILESTONE", turnId, eventAtSim: THU_10_AR, template: { name: "legajo_docs_pendientes", params: ["Estudio Delta", "4490", "Austral Aurora", "22/10", "packing list"] } };
    const result = await sendOutbound(world.deps, request, world.call());
    expect(result).toMatchObject({ status: "SENT" });
    expect(world.liveSends).toEqual([]);
    if (result.status !== "SENT") throw new Error("expected SENT");
    expect(await world.stores.connector.conversations.getMessage(guest.operationId, result.messageId)).toMatchObject({ simulated: true, from: "simulated", clockId: GUEST_CLOCK });
  });
});

describe("[FL-123] the SYSTEM fence of a guest world", () => {
  it("refuses a registered demo recipient that a demo world may write to", async () => {
    const guest = await world.guestOperation(DEMO_RECIPIENT);
    expect(await emailFence(world.deps.fence, { operation: world.op4471, from: world.op4471.threadAddress, to: DEMO_RECIPIENT })).toMatchObject({ allowed: true });
    expect(await emailFence(world.deps.fence, { operation: guest, from: guest.threadAddress, to: DEMO_RECIPIENT })).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "SYSTEM_RECIPIENT" });
  });

  it("refuses every domain outside the simulated mailboxes, and lets the simulators through", async () => {
    const guest = await world.guestOperation(GUEST_MAILBOX);
    const fence = (to: string) => emailFence(world.deps.fence, { operation: guest, from: guest.threadAddress, to });
    expect(await fence("compras@craftech.io")).toMatchObject({ allowed: false, reason: "SYSTEM_RECIPIENT" });
    expect(await fence("ventas@example.com")).toMatchObject({ allowed: false, reason: "RESERVED_DOMAIN" });
    expect(await fence(guest.threadAddress)).toMatchObject({ allowed: false, reason: "SYSTEM_TO_THREAD" });
    expect(await fence(GUEST_MAILBOX)).toMatchObject({ allowed: true });
    expect(await fence("bounce+g41@simulator.amazonses.com")).toMatchObject({ allowed: true });
  });

  it("an email to a demo recipient contact of a guest world is a DENY under CP-RECIPIENT-FENCE, and SES is never called", async () => {
    const guest = await world.guestOperation(DEMO_RECIPIENT);
    const turnId = await world.turn([{ tool: "get_dossier", output: { invoiceNumber: "QBT-2026-0917" } }], "SUPPLIER_EMAIL");
    const result = await sendOutbound(world.deps, guestEmail(guest.operationId, turnId), world.call());
    expect(result).toMatchObject({ status: "REFUSED", ruleIds: ["CP-RECIPIENT-FENCE"], failure: { error: { code: "RECIPIENT_NOT_ALLOWED" } } });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect((await world.stores.connector.audit.listByOperation(guest.operationId)).at(-1)).toMatchObject({ decision: "DENY", ruleIds: ["CP-RECIPIENT-FENCE"], clockId: GUEST_CLOCK });
  });
});

describe("[FL-123] the quota of outgoing emails of a guest world", () => {
  it("counts each email, and past the hour's limit answers QUOTA_EXCEEDED with an audited DENY", async () => {
    const guest = await world.guestOperation(GUEST_MAILBOX);
    const turnId = await world.turn([{ tool: "get_dossier", output: { invoiceNumber: "QBT-2026-0917" } }], "SUPPLIER_EMAIL");
    expect(await sendOutbound(world.deps, guestEmail(guest.operationId, turnId), world.call())).toMatchObject({ status: "SENT" });
    const hour = GUEST_QUOTAS.OUTBOUND_EMAILS.find((limit) => limit.window === "HOUR")?.limit ?? 0;
    const quota = { client: world.stores.client, now: () => new Date(REAL_NOW), log: createLogger({ level: "error" }) };
    for (let index = 1; index < hour; index += 1) await consumeQuota(quota, GUEST_CLOCK, "OUTBOUND_EMAILS");
    const refused = await sendOutbound(world.deps, guestEmail(guest.operationId, turnId), world.call());
    expect(refused).toMatchObject({ status: "REFUSED", ruleIds: ["CP-WORLD-QUOTA"], failure: { error: { code: "POLICY_DENIED", reason: "QUOTA_EXCEEDED" } } });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect((await world.stores.connector.audit.listByOperation(guest.operationId)).at(-1)).toMatchObject({ decision: "DENY", ruleIds: ["CP-WORLD-QUOTA"] });
  });

  it("a demo world has no quota, and an email the policy defers never spends one", async () => {
    const guest = await world.guestOperation(GUEST_MAILBOX);
    const turnId = await world.turn([{ tool: "get_dossier", output: { invoiceNumber: "QBT-2026-0917" } }], "SUPPLIER_EMAIL");
    const deferred = await sendOutbound(world.deps, { ...guestEmail(guest.operationId, turnId), eventAtSim: THU_10_AR }, world.call());
    expect(deferred).toMatchObject({ status: "DEFERRED" });
    expect(world.stores.client.dump("Runtime").filter((row) => row.PK.startsWith("QUOTA#"))).toEqual([]);
    expect(await sendOutbound(world.deps, guestEmail("op-4471", turnId), world.call())).toMatchObject({ status: "SENT" });
    expect(world.stores.client.dump("Runtime").filter((row) => row.PK.startsWith("QUOTA#"))).toEqual([]);
  });
});
