// Importer questions on the real prompt, tools and Cedar statements, answered by the run's model
// (docs/flows-catalog.md, area E; the scripted versions are tests/flows/questions.flow.test.ts). The
// oracles follow docs/test-plan.md §4.3: tools called, state and structure, never the model's wording.
import { describe, expect, it } from "vitest";
import { toolsOf, useAgentWorld } from "./support/agent-world";

const worlds = useAgentWorld();
const TURN_TIMEOUT_MS = 300_000;

describe("importer questions (agent)", () => {
  it("[FL-020] \"¿Qué me falta?\": reads the dossier and replies on WhatsApp with the three missing documents", async () => {
    const { flow, agent } = await worlds.open();

    await flow.say("imp-patagonia", "4474", "¿Qué me falta?");

    const turn = agent.turns.at(-1);
    expect(turn, "the message ran a turn").toBeDefined();
    expect(toolsOf(turn ?? { calls: [] })).toContain("get_dossier");
    const replies = (await flow.messages("op-4474")).filter((message) => message.direction === "OUT" && message.author === "AGENT");
    expect(replies.length, `no agent reply; the turn ended ${turn?.stopReason} with: ${turn?.text}`).toBeGreaterThan(0);
    expect(replies.at(-1)?.refs?.docTypes ?? []).toEqual(expect.arrayContaining(["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"]));
  }, TURN_TIMEOUT_MS);

  it("[FL-045] \"¿El certificado tiene que estar firmado?\": answers from the checklist of the certificate of origin", async () => {
    const { flow, agent } = await worlds.open();

    await flow.say("imp-patagonia", "4474", "¿El certificado de origen tiene que estar firmado?");

    const turn = agent.turns.at(-1);
    expect(toolsOf(turn ?? { calls: [] })).toContain("get_checklist");
    const checklist = turn?.calls.find((call) => call.name.endsWith("get_checklist"));
    expect(checklist?.input["docType"]).toBe("CERTIFICATE_OF_ORIGIN");
    const replies = (await flow.messages("op-4474")).filter((message) => message.direction === "OUT" && message.author === "AGENT");
    expect(replies.length, `no agent reply; the turn ended ${turn?.stopReason} with: ${turn?.text}`).toBeGreaterThan(0);
  }, TURN_TIMEOUT_MS);
});
