// `CP-NO-FOREIGN-LINKS` on the firm's emails: the escalation report and the dossier ready for review
// (copy/firm-mail.ts) end with the operation's own console link, which the allowance admits for the
// firm's mailbox only; any other link in them, or the console link in a text to another party, is still
// refused.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { beforeEach, describe, expect, it } from "vitest";
import { consoleUrlOf } from "./links";
import { sendOutbound } from "./pipeline";
import { THU_10_AR, outboundWorld, type OutboundWorld } from "./testing";
import type { FirmEmailSend } from "./types";

let world: OutboundWorld;

beforeEach(async () => {
  world = await outboundWorld();
});

function firmEmail(text: string, messageId: string): FirmEmailSend {
  return { operationId: "op-4471", channel: "EMAIL", counterpart: "FIRM", kind: "ESCALATION", author: "SYSTEM", textSource: "CODE", eventAtSim: THU_10_AR, subject: "Operación 4471", text, messageId };
}

describe("CP-NO-FOREIGN-LINKS on the firm's emails", () => {
  it("the operation's own console link reaches the firm's mailbox", async () => {
    const result = await sendOutbound(world.deps, firmEmail(`Operación 4471: listo para revisión.\n${consoleUrlOf("op-4471")}`, "msg-firmready000000000001"), world.call());
    expect(result).toMatchObject({ status: "SENT" });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it("another operation's console link, or any other link, is refused", async () => {
    for (const [index, link] of [consoleUrlOf("op-4472"), "https://example.com/pay"].entries()) {
      const result = await sendOutbound(world.deps, firmEmail(`Operación 4471.\n${link}`, `msg-firmforeign00000000000${index}`), world.call());
      expect(result).toMatchObject({ status: "REFUSED", ruleIds: ["CP-NO-FOREIGN-LINKS"] });
    }
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("the console link stays out of a text to the importer", async () => {
    const turnId = await world.turn([], "IMPORTER_MESSAGE");
    await world.inbound("¿Cómo va?", "2026-10-15T09:30:00-03:00");
    const result = await sendOutbound(
      world.deps,
      { operationId: "op-4471", channel: "WHATSAPP", kind: "REPLY", author: "AGENT", textSource: "CODE", trigger: "IMPORTER_MESSAGE", turnId, eventAtSim: THU_10_AR, text: `Mirá el legajo en ${consoleUrlOf("op-4471")}` },
      world.call(),
    );
    expect(result).toMatchObject({ status: "REFUSED", ruleIds: ["CP-NO-FOREIGN-LINKS"] });
  });
});
