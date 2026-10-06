// Importer questions on the real prompt, tools and Cedar statements, answered by the run's model
// (docs/flows-catalog.md, area E; the scripted versions are tests/flows/questions.flow.test.ts). The
// oracles follow docs/test-plan.md §4.3: tools called, state and structure, never the model's wording.
import { describe, expect, it } from "vitest";
import { toolsOf, useAgentWorld } from "./support/agent-world";

const worlds = useAgentWorld();
const TURN_TIMEOUT_MS = 600_000;

describe("importer questions (agent)", () => {
  it("[FL-020] \"¿Qué me falta?\": answers from the dossier the turn already read, on WhatsApp, with the three missing documents", async () => {
    const { flow, agent } = await worlds.open();

    await flow.say("imp-patagonia", "4474", "¿Qué me falta?");

    const turn = agent.turns.at(-1);
    expect(turn, "the message ran a turn").toBeDefined();
    expect(toolsOf(turn ?? { calls: [] }), "the reads come in the envelope (ADR-0019)").not.toEqual(expect.arrayContaining(["get_dossier"]));
    const replies = (await flow.messages("op-4474")).filter((message) => message.direction === "OUT" && message.author === "AGENT");
    expect(replies.length, `no agent reply; the turn ended ${turn?.stopReason} with: ${turn?.text}`).toBeGreaterThan(0);
    expect(replies.at(-1)?.refs?.docTypes ?? []).toEqual(expect.arrayContaining(["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"]));
  }, TURN_TIMEOUT_MS);

  it("[FL-045] \"¿El certificado tiene que estar firmado?\": answers from the checklist of the certificate of origin", async () => {
    const { flow, agent } = await worlds.open();

    await flow.say("imp-patagonia", "4474", "¿El certificado de origen tiene que estar firmado?");

    const turn = agent.turns.at(-1);
    expect(toolsOf(turn ?? { calls: [] }), "the checklist comes in the envelope (ADR-0019)").not.toEqual(expect.arrayContaining(["get_checklist"]));
    const replies = (await flow.messages("op-4474")).filter((message) => message.direction === "OUT" && message.author === "AGENT");
    expect(replies.length, `no agent reply; the turn ended ${turn?.stopReason} with: ${turn?.text}`).toBeGreaterThan(0);
  }, TURN_TIMEOUT_MS);

  it("[FL-020] a greeting gets one short status reply, without reading anything: the reads come in the envelope", async () => {
    const { flow, agent } = await worlds.open();

    await flow.say("imp-patagonia", "4474", "hola");

    const turn = agent.turns.at(-1);
    expect(new Set(toolsOf(turn ?? { calls: [] }))).toEqual(new Set(["send_whatsapp"]));
    const replies = (await flow.messages("op-4474")).filter((message) => message.direction === "OUT" && message.author === "AGENT");
    expect(replies.length, `no agent reply; the turn ended ${turn?.stopReason} with: ${turn?.text}`).toBe(1);
  }, TURN_TIMEOUT_MS);
});
