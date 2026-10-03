import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, FIRM } from "../connector/testing";
import { shownAddress } from "./mailbox";
import { type ConsoleWorld, DIEGO, PABLO, consoleWorld, principalOf, SUBS } from "./testing";

const FIRM_MAILBOX = "estudio-delta@sim.legajo.demo.craftech.io";
const SUPPLIER_MAILBOX = "supplier-qingdao@sim.legajo.demo.craftech.io";

describe("mailbox router", () => {
  let world: ConsoleWorld;

  beforeEach(async () => {
    world = await consoleWorld();
    const { conversations } = world.stores.connector;
    const mail = { firmId: FIRM, clockId: CLOCK, operationId: "op-4471", from: "avisos@legajo.demo.craftech.io", subject: "[Op 4471] Escalamiento", bodyText: "Estado del legajo 4471", references: [] };
    await conversations.putMailboxMessage({ ...mail, mailboxAddress: FIRM_MAILBOX, to: FIRM_MAILBOX, mailboxMessageId: "m1", receivedAtReal: "2026-09-26T15:00:00.000Z" });
    await conversations.putMailboxMessage({ ...mail, mailboxAddress: SUPPLIER_MAILBOX, to: SUPPLIER_MAILBOX, from: "op-4471-k7p2q9@legajo.demo.craftech.io", subject: "Operation 4471", bodyText: "Documents requested", mailboxMessageId: "m2", receivedAtReal: "2026-09-26T15:01:00.000Z" });
    // A mail another firm's operation left in the same simulated mailbox is never shown here.
    await conversations.putMailboxMessage({ ...mail, firmId: "firm-norte", clockId: "GLOBAL#firm-norte", operationId: "op-5501", mailboxAddress: SUPPLIER_MAILBOX, to: SUPPLIER_MAILBOX, mailboxMessageId: "m3", receivedAtReal: "2026-09-26T15:02:00.000Z" });
  });

  it("[FL-084] lists the firm's and the suppliers' demo mailboxes, filtered by the firm of the operation", async () => {
    const list = await world.caller(DIEGO).mailbox.list({});
    expect(list.mailboxes.map((mailbox) => [mailbox.address, mailbox.owner, mailbox.messages.map((message) => message.mailboxMessageId)])).toEqual([
      [FIRM_MAILBOX, "FIRM", ["m1"]],
      [SUPPLIER_MAILBOX, "SUPPLIER", ["m2"]],
    ]);
    expect(JSON.stringify(list)).not.toContain("bodyText");
  });

  it("[FL-084] opens one mail as plain text, and nothing of another firm", async () => {
    const mail = await world.caller(DIEGO).mailbox.get({ mailboxAddress: SUPPLIER_MAILBOX, mailboxMessageId: "m2" });
    expect(mail).toMatchObject({ subject: "Operation 4471", bodyText: "Documents requested", operationId: "op-4471" });
    await expect(world.caller(DIEGO).mailbox.get({ mailboxAddress: SUPPLIER_MAILBOX, mailboxMessageId: "m3" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(world.caller(PABLO).mailbox.get({ mailboxAddress: FIRM_MAILBOX, mailboxMessageId: "m1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("[FL-084] a mail without a world is shown only to a firm with one world; firm-qa never sees it", async () => {
    const { conversations } = world.stores.connector;
    await conversations.putMailboxMessage({ firmId: FIRM, from: "avisos@legajo.demo.craftech.io", subject: "Sin mundo", bodyText: "x", references: [], mailboxAddress: FIRM_MAILBOX, to: FIRM_MAILBOX, mailboxMessageId: "m4", receivedAtReal: "2026-09-26T15:03:00.000Z" });
    expect((await world.caller(DIEGO).mailbox.list({})).mailboxes[0]?.messages.map((message) => message.mailboxMessageId)).toEqual(expect.arrayContaining(["m4"]));
    await conversations.putMailboxMessage({ firmId: "firm-qa", from: "avisos@legajo.demo.craftech.io", subject: "Sin mundo", bodyText: "x", references: [], mailboxAddress: "estudio-qa@sim.legajo.demo.craftech.io", to: "estudio-qa@sim.legajo.demo.craftech.io", mailboxMessageId: "m5", receivedAtReal: "2026-09-26T15:03:00.000Z" });
    const qa = principalOf("firm-qa", "BROKER", SUBS.diego, "brk-qa-runner");
    await world.stores.connector.world.createClock({ clockId: "qa-812-sc01", firmId: "firm-qa", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-14T10:30:00-03:00", startAtSim: "2026-10-14T10:30:00-03:00", worldEpoch: 1, settings: { rateLimitPerHour: 20 } });
    const list = await world.caller(qa).mailbox.list({ clockId: "qa-812-sc01" });
    expect(list.mailboxes.flatMap((mailbox) => mailbox.messages)).toEqual([]);
  });

  it("masks every address that is not one of ours", () => {
    expect(shownAddress("supplier-qingdao@sim.legajo.demo.craftech.io")).toBe("supplier-qingdao@sim.legajo.demo.craftech.io");
    expect(shownAddress("avisos@legajo.demo.craftech.io")).toBe("avisos@legajo.demo.craftech.io");
    expect(shownAddress("buyer@example.com")).not.toContain("buyer");
    expect(shownAddress("x@legajo.demo.craftech.io.example.com")).not.toBe("x@legajo.demo.craftech.io.example.com");
  });
});
