// Local flows of the importer's questions (docs/flows-catalog.md, area E): what is missing, answers
// grounded on the checklist, questions it does not cover, denied topics, an unrelated topic, the delay
// risk with its labelled assumptions and the meaning of a customs channel. The importer of op-4474
// (four open operations) picks the operation in the choice list before each question; G1 and G2 answer
// from the guardrail script of the AWS fakes. The assertions follow the oracles of docs/test-plan.md
// §4.3: state and structure, never the wording a model would choose.
import type { ApplyGuardrailCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { PASSING_GUARDRAIL, type GuardrailScript } from "./support/fakes/aws";
import { DOCS_REQUEST_PLAN, READ_DOSSIER, READ_OPERATION, escalate, missingText, outputOf, reply } from "./support/plans";
import type { Plan } from "./support/scripted-harness";
import { useFlowWorld } from "./support/lifecycle";
import type { FlowWorld } from "./support/world";

const worlds = useFlowWorld();

async function open(plans: Parameters<typeof worlds.open>[0], guardrail?: GuardrailScript): Promise<FlowWorld> {
  return worlds.open(plans, guardrail === undefined ? {} : { guardrail });
}

const ask = (flow: FlowWorld, text: string) => flow.say("imp-patagonia", "4474", text);
const repliesOf = async (flow: FlowWorld) => (await flow.messages("op-4474")).filter((message) => message.direction === "OUT" && message.kind === "REPLY");
const openEscalations = (flow: FlowWorld) => flow.data.operations.listEscalations("op-4474", { status: "OPEN" });

const DENIED_TOPICS = [
  "¿Qué posición arancelaria le corresponde a esto?",
  "¿Qué valor declaro en aduana?",
  "¿Cuánto voy a pagar de impuestos?",
  "Decile al proveedor que me devuelva la plata",
  "¿Me conviene hacer el despacho a plaza o en depósito?",
];

/** G1 blocks the five denied topics on input (a topic policy), and lets everything else through. */
const DENIED_TOPICS_G1: GuardrailScript = (input: ApplyGuardrailCommandInput) => {
  const text = input.content?.map((block) => block.text?.text ?? "").join(" ") ?? "";
  if (input.source === "INPUT" && DENIED_TOPICS.some((topic) => text.includes(topic))) {
    return { action: "GUARDRAIL_INTERVENED", outputs: [{ text: "blocked" }], assessments: [{ topicPolicy: { topics: [{ name: "CUSTOMS_ADVICE", type: "DENY", action: "BLOCKED" }] } }] };
  }
  return PASSING_GUARDRAIL(input);
};

describe("importer question flows", () => {
  it("[FL-020] \"¿Qué me falta?\": the IMPORTER_MESSAGE turn reads the dossier and answers with refs.docTypes = the missing documents; G2 passes", async () => {
    const plan: Plan = {
      steps: [READ_DOSSIER, { tool: "send_whatsapp", input: (context) => ({ recipientRole: "IMPORTER", kind: "REPLY", text: `Te faltan ${missingText(context)}.`, refs: { docTypes: outputOf(context.calls, "get_dossier").missing } }) }],
      note: "Respondí qué falta.",
    };
    const flow = await open({ "4474": { IMPORTER_MESSAGE: [plan] } });

    await ask(flow, "¿Qué me falta?");

    const [answer] = await repliesOf(flow);
    expect(answer).toMatchObject({ author: "AGENT", refs: { docTypes: ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] } });
    expect(answer?.body).toBe("Te faltan factura comercial, packing list y certificado de origen.");
    expect(flow.harness.turns[0]?.calls[1]?.output).toMatchObject({ ok: true, guardrail: { action: "NONE" } });
    expect(flow.aws.guardrailCalls.some((call) => call.source === "OUTPUT")).toBe(true);
  });

  it("[FL-045] the QUESTION button and \"¿El certificado tiene que estar firmado?\": get_checklist(CERTIFICATE_OF_ORIGIN) and a REPLY grounded on CO-02 (score ≥ 0.75), with the item in the turn's results", async () => {
    const answer: Plan = { steps: [{ tool: "get_checklist", input: { docType: "CERTIFICATE_OF_ORIGIN" } }, reply("REPLY", "Sí: tiene que estar firmado y sellado por la entidad emisora.")], note: "Respondí desde el checklist." };
    const flow = await open({ "4474": { MILESTONE: [DOCS_REQUEST_PLAN], IMPORTER_MESSAGE: [answer] } });
    await flow.fire("op-4474", "DOCS_REQUEST");

    await flow.tap("op-4474", "QUESTION");
    expect((await flow.messages("op-4474")).filter((message) => message.direction === "OUT" && message.author === "SYSTEM").length).toBeGreaterThan(0);
    await ask(flow, "¿El certificado tiene que estar firmado?");

    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "IMPORTER_MESSAGE");
    expect(JSON.stringify(turn?.calls[0]?.output)).toContain('"itemId":"CO-02"');
    const turnRows = flow.stores.client.dump("Runtime").filter((row) => String(row.PK).startsWith("TURN#"));
    expect(turnRows.some((row) => JSON.stringify(row).includes("CO-02"))).toBe(true);
    const sent = turn?.calls[1]?.output as { ok: boolean; guardrail?: { groundingScore?: number } };
    expect(sent.ok).toBe(true);
    expect(sent.guardrail?.groundingScore).toBeGreaterThanOrEqual(0.75);
    expect((await repliesOf(flow)).filter((message) => message.author === "AGENT")).toHaveLength(1);
  });

  it("[FL-046] \"¿Necesito también el BL original?\": the checklist has no item for it; the agent defers to the firm and escalates OUT_OF_CHECKLIST, with exactly one open escalation and nothing said about the BL", async () => {
    const plan: Plan = { steps: [{ tool: "get_checklist", input: {} }, reply("REPLY", "Eso lo confirma el estudio; ya le pasamos tu consulta."), escalate("OUT_OF_CHECKLIST", "Consulta fuera del checklist.")], note: "Fuera del checklist." };
    const flow = await open({ "4474": { IMPORTER_MESSAGE: [plan] } });

    await ask(flow, "¿Necesito también el BL original?");

    expect((await openEscalations(flow)).map((escalation) => escalation.reason)).toEqual(["OUT_OF_CHECKLIST"]);
    const [answer] = await repliesOf(flow);
    expect(answer?.body).not.toMatch(/\bBL\b|conocimiento de embarque/i);
  });

  it("[FL-047] the five denied topics blocked by the G1 pre-filter: no Harness call, a fixed refusal by SYSTEM, a direct OUT_OF_CHECKLIST escalation and GUARDRAIL_BLOCK origin PREFILTER; one open escalation after the five; the next milestone runs a normal turn", async () => {
    const flow = await open({ "4474": { MILESTONE: [DOCS_REQUEST_PLAN] } }, DENIED_TOPICS_G1);

    for (const topic of DENIED_TOPICS) await ask(flow, topic);

    expect(flow.harness.turns).toEqual([]);
    const refusals = await repliesOf(flow);
    expect(refusals).toHaveLength(5);
    expect(refusals.every((message) => message.author === "SYSTEM")).toBe(true);
    expect((await openEscalations(flow)).map((escalation) => escalation.reason)).toEqual(["OUT_OF_CHECKLIST"]);
    const blocks = (await flow.data.audit.listByOperation("op-4474")).filter((row) => row.action === "GUARDRAIL_BLOCK");
    expect(blocks).toHaveLength(5);
    expect(blocks.every((row) => (row.detail as { origin?: string; source?: string } | undefined)?.origin === "PREFILTER")).toBe(true);

    await flow.fire("op-4474", "DOCS_REQUEST");

    expect(flow.harness.turns.map((turn) => turn.envelope.event.type)).toEqual(["MILESTONE"]);
  });

  it("[FL-049] \"¿Viste el partido?\": one REPLY that brings the conversation back to the operation, no escalation", async () => {
    const plan: Plan = { steps: [READ_OPERATION, reply("REPLY", "Te escribo solo por la operación 4474. ¿Te ayudo con algo de los documentos?")], note: "Tema ajeno." };
    const flow = await open({ "4474": { IMPORTER_MESSAGE: [plan] } });

    await ask(flow, "¿Viste el partido?");

    const replies = await repliesOf(flow);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.operationId).toBe("op-4474");
    expect(await openEscalations(flow)).toEqual([]);
  });

  it("[FL-052] \"¿Cuánto me sale si se atrasa?\": estimate_delay_risk and a REPLY with the word \"supuesto\" and only figures of the tool result", async () => {
    const plan: Plan = { steps: [{ tool: "estimate_delay_risk", input: {} }, reply("REPLY", (context) => String(outputOf(context.calls, "estimate_delay_risk").text))], note: "Riesgo con supuestos." };
    const flow = await open({ "4474": { IMPORTER_MESSAGE: [plan] } });

    await ask(flow, "¿Cuánto me sale si se atrasa?");

    const [answer] = await repliesOf(flow);
    expect(answer?.body).toContain("supuesto");
    const risk = flow.harness.turns[0]?.calls[0]?.output as { estimatedCostUsd: { min: number; max: number } };
    expect(answer?.body).toContain(`USD ${risk.estimatedCostUsd.min.toLocaleString("es-AR")}`);
  });

  it("[FL-053] \"¿Qué significa canal naranja?\" on the approved op-4487 with CANAL_ASIGNADO NARANJA: the text lands on the dossier in work and moves to op-4487, get_dispatch_status and a REPLY grounded on genericExplanation goes out despite APPROVED", async () => {
    const plan: Plan = { steps: [{ tool: "get_dispatch_status", input: {} }, reply("REPLY", (context) => String(outputOf(context.calls, "get_dispatch_status").genericExplanation))], note: "Expliqué el canal." };
    const flow = await open({ "4487": { IMPORTER_MESSAGE: [plan] } });
    await flow.console().clock.emitDispatchStatus({ operationId: "op-4487", status: "CANAL_ASIGNADO", channel: "NARANJA" });
    await flow.entries.settle();

    const messageId = await flow.say("imp-norpampa", "4487", "¿Qué significa canal naranja?");

    expect(messageId).not.toBe("");
    // A quiet chat lands on the anchor, op-4478 (the approved op-4487 goes last); the agent moves it to op-4487 (ADR-0017).
    expect((await flow.messages("op-4478")).some((message) => message.kind === "OPERATION_CHOICE")).toBe(false);
    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.operation === "4487");
    expect(turn?.envelope.event).toMatchObject({ type: "IMPORTER_MESSAGE", operation: "4487" });
    const status = turn?.calls[0]?.output as { status?: string; channel?: string; genericExplanation?: string };
    expect(status).toMatchObject({ ok: true, status: "CANAL_ASIGNADO", channel: "NARANJA" });
    const answer = (await flow.messages("op-4487")).find((message) => message.direction === "OUT" && message.kind === "REPLY");
    expect(answer?.body).toBe(status.genericExplanation);
    expect(["SENT", "DELIVERED", "READ"]).toContain(answer?.status);
    const allow = (await flow.data.audit.listByOperation("op-4487")).find((row) => row.decision === "ALLOW" && row.refs?.messageId === answer?.messageId);
    expect(allow?.ruleIds).toContain("CP-APPROVED-SCOPE");
  });
});
