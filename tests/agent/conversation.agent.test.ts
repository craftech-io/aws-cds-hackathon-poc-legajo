// The importer's WhatsApp as one conversation (ADR-0017), on the run's model: a text about another
// operation is moved there with route_to_operation; a question across operations is answered where it
// landed. Oracles: tools called and where the reply went, never the wording.
import { describe, expect, it } from "vitest";
import { toolsOf, useAgentWorld } from "./support/agent-world";

const worlds = useAgentWorld();
const TURN_TIMEOUT_MS = 600_000;

describe("importer conversation across operations (agent)", () => {
  it("[FL-019] a text about another open operation is answered about that operation: moved there, or answered in place from otherOperations", async () => {
    const { flow, agent } = await worlds.open();

    const sent = await flow.phone(await flow.phoneOf("imp-patagonia"), { type: "text", text: "¿Qué me falta en la operación 4475?" });

    const landed = sent.summary.records[0]?.messages[0]?.operationId ?? "";
    const routed = toolsOf(agent.turns[0] ?? { calls: [] }).includes("route_to_operation");
    if (routed) expect(agent.turns[0]?.calls.find((call) => call.name.endsWith("route_to_operation"))?.input["toOperationNumber"]).toBe("4475");
    const replies = (await flow.messages(routed ? "op-4475" : landed)).filter((message) => message.direction === "OUT" && message.author === "AGENT");
    expect(replies.length, `no reply; turns: ${agent.turns.map((turn) => `${turn.stopReason}:${turn.calls.map((call) => call.name).join(",")}`).join(" | ")}`).toBeGreaterThan(0);
    if (!routed) expect(replies.some((message) => message.body.includes("4475"))).toBe(true);
  }, TURN_TIMEOUT_MS);

  it("[FL-019] a question across operations is answered where it landed, without moving it", async () => {
    const { flow, agent } = await worlds.open();

    const sent = await flow.phone(await flow.phoneOf("imp-patagonia"), { type: "text", text: "Tengo varias operaciones abiertas, ¿cuál está más atrasada con la documentación?" });

    const landed = sent.summary.records[0]?.messages[0]?.operationId ?? "";
    expect(toolsOf(agent.turns[0] ?? { calls: [] })).not.toContain("route_to_operation");
    const replies = (await flow.messages(landed)).filter((message) => message.direction === "OUT" && message.author === "AGENT");
    expect(replies.length, `no reply; the turn ended ${agent.turns[0]?.stopReason} with: ${agent.turns[0]?.text}`).toBeGreaterThan(0);
  }, TURN_TIMEOUT_MS);
});
