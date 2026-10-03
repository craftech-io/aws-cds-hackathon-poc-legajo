// Local flows of the handoff to people (docs/flows-catalog.md, area H): the importer asks for a person,
// the ESCALATION milestone writes the firm what is missing, and the firm gives the conversation back to
// the agent. The firm's mailbox is the simulated one SimMail keeps (`MailboxMessage`).
import { describe, expect, it } from "vitest";
import { DIEGO } from "@legajo/bff/routers/testing";
import { DOCS_REQUEST_PLAN, READ_DOSSIER, READ_OPERATION, SEND_DOCS_REQUEST, escalate } from "./support/plans";
import { useFlowWorld } from "./support/lifecycle";
import type { Plan } from "./support/scripted-harness";

const worlds = useFlowWorld();

const mailboxOf = async (flow: Awaited<ReturnType<typeof worlds.open>>) => flow.data.conversations.listMailbox((await flow.data.firms.getFirm("firm-delta")).mailboxAddress);

describe("handoff flows", () => {
  it("[FL-048] \"Quiero hablar con una persona\": escalate_to_broker(IMPORTER_ASKED, notifyImporter) sends legajo_escalado and mails the firm; the escalation stays open", async () => {
    const plan: Plan = { steps: [READ_OPERATION, escalate("IMPORTER_ASKED", "El importador pidió hablar con una persona.", true)], note: "Pasé a una persona." };
    const flow = await worlds.open({ "4474": { IMPORTER_MESSAGE: [plan] } });

    await flow.say("imp-patagonia", "4474", "Quiero hablar con una persona del estudio");

    expect(flow.harness.turns[0]?.calls[1]?.output).toMatchObject({ ok: true });
    expect((await flow.data.operations.listEscalations("op-4474", { status: "OPEN" })).map((escalation) => escalation.reason)).toEqual(["IMPORTER_ASKED"]);
    const notice = (await flow.messages("op-4474")).find((message) => message.direction === "OUT" && message.template?.name === "legajo_escalado");
    expect(notice).toBeDefined();
    expect((await mailboxOf(flow)).some((message) => message.operationId === "op-4474")).toBe(true);
  });

  it("[FL-066] the ESCALATION milestone of op-4478 (NEVER supplier) with documents missing opens MISSING_AT_ETA_48H by code, with the attempts and who owes what, mails the firm from avisos@ with the labelled assumption and tells the importer", async () => {
    const flow = await worlds.open({});

    await flow.fire("op-4478", "ESCALATION");

    const [escalation] = await flow.data.operations.listEscalations("op-4478", { status: "OPEN" });
    expect(escalation?.reason).toBe("MISSING_AT_ETA_48H");
    const mail = (await mailboxOf(flow)).find((message) => message.operationId === "op-4478");
    expect(mail?.from).toMatch(/^avisos@/);
    expect(mail?.bodyText).toContain("supuesto");
    expect(mail?.bodyText).toContain("Ligurmare");
    expect((await flow.messages("op-4478")).some((message) => message.direction === "OUT" && message.channel === "WHATSAPP" && message.kind === "ESCALATION_NOTICE")).toBe(true);
    expect(flow.harness.turns.filter((turn) => turn.envelope.event.operation === "4478")).toEqual([]);
  });

  it("[FL-070] \"Devolver al agente\" after the firm wrote: release_conversation gives control back and the BROKER_RELEASED turn's envelope carries what the firm wrote; a second DOCS_REQUEST the same day is held by CP-ONE-PER-DAY", async () => {
    const resumed: Plan = { steps: [READ_OPERATION, READ_DOSSIER, SEND_DOCS_REQUEST], note: "Retomé." };
    const flow = await worlds.open({ "4474": { MILESTONE: [DOCS_REQUEST_PLAN], IMPORTER_MESSAGE: [{ steps: [READ_DOSSIER], note: "Leí." }], BROKER_RELEASED: [resumed] } });
    await flow.fire("op-4474", "DOCS_REQUEST");
    await flow.say("imp-patagonia", "4474", "Hola, ¿me pueden llamar?");

    await flow.console(DIEGO).conversation.take({ operationId: "op-4474" });
    await flow.console(DIEGO).conversation.send({ operationId: "op-4474", text: "Hola, soy Diego del estudio. Te llamo en un rato." });
    await flow.entries.settle();
    await flow.console(DIEGO).conversation.release({ operationId: "op-4474" });
    await flow.entries.settle();

    expect((await flow.messages("op-4474")).find((message) => message.kind === "BROKER_MESSAGE")).toMatchObject({ author: "BROKER:brk-delta-diego" });
    expect((await flow.data.operations.getOperation("op-4474")).control).toBe("AGENT");
    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "BROKER_RELEASED");
    expect(turn?.envelope.text).toContain("Te llamo en un rato.");
    expect(turn?.calls[2]?.output).toMatchObject({ ok: true, status: "DEFERRED", policyResult: { ruleIds: ["CP-ONE-PER-DAY"] } });
    expect((await flow.messages("op-4474")).filter((message) => message.kind === "DOCS_REQUEST" && message.status !== "DEFERRED")).toHaveLength(1);
  });
});
