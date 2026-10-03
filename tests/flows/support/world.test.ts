import { BedrockAgentCoreClient, InvokeHarnessCommand, type InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { PABLO } from "@legajo/bff/routers/testing";
import { resolveSession } from "@legajo/bff/services/session";
import { afterEach, describe, expect, it } from "vitest";
import { planQueue } from "./scripted-harness";
import { createFlowWorld, type FlowWorld } from "./world";

let world: FlowWorld | undefined;

afterEach(() => {
  world?.close();
  world = undefined;
});

async function open(options: Parameters<typeof createFlowWorld>[0] = {}): Promise<FlowWorld> {
  world = await createFlowWorld(options);
  return world;
}

describe("in-process world of the local flows", () => {
  it("starts from the demo slice with its clock paused at the start of the world", async () => {
    const flow = await open();
    expect((await flow.simNow()).toISOString()).toBe(new Date("2026-10-14T10:30:00-03:00").toISOString());
    flow.advanceReal(3_600_000);
    expect((await flow.simNow()).toISOString()).toBe(new Date("2026-10-14T10:30:00-03:00").toISOString());
    const { operation } = await flow.console().operations.get({ operationId: "op-4471" });
    expect(operation).toMatchObject({ operationNumber: "4471", dossierStatus: "OPEN", clockId: flow.clockId });
  });

  it("serves the console through the real appRouter, firm fence included", async () => {
    const flow = await open();
    await expect(flow.console(PABLO).operations.get({ operationId: "op-4471" })).rejects.toThrow();
  });

  it("opens a turn whose token the stage's session check accepts for that operation only", async () => {
    const flow = await open();
    const turn = await flow.openTurn({ operationId: "op-4471", trigger: "IMPORTER_MESSAGE" });
    const resolved = await resolveSession(flow.subkey("session"), turn.sessionToken, flow.data.runtime, flow.realNow().getTime());
    expect(resolved).toMatchObject({ operationId: "op-4471", importerId: "imp-norpampa", supplierId: "sup-qingdao", trigger: "IMPORTER_MESSAGE", clockId: flow.clockId });
    expect(turn.envelope).toContain('operation="4471"');
    await flow.data.runtime.closeTurn(turn.turn.turnId, flow.realNow().toISOString());
    await expect(resolveSession(flow.subkey("session"), turn.sessionToken, flow.data.runtime, flow.realNow().getTime())).rejects.toThrow(/closed/);
  });

  it("answers InvokeHarness through the AgentCore SDK with the scripted turn", async () => {
    const flow = await open({ plans: planQueue([{ steps: [], note: "nothing to do in this turn" }]) });
    const turn = await flow.openTurn({ operationId: "op-4471", trigger: "MILESTONE" });
    const response = await new BedrockAgentCoreClient({ region: "us-east-1" }).send(
      new InvokeHarnessCommand({ harnessArn: "arn:aws:bedrock-agentcore:us-east-1:000000000000:harness/local", qualifier: "live", runtimeSessionId: "local-session-0001", messages: [{ role: "user", content: [{ text: turn.envelope }] }] }),
    );
    const events: InvokeHarnessStreamOutput[] = [];
    for await (const event of response.stream ?? []) events.push(event);
    expect(events.some((event) => event.contentBlockDelta?.delta?.text === "nothing to do in this turn")).toBe(true);
    expect(flow.aws.harnessCalls).toHaveLength(1);
    expect(flow.harness.turns[0]?.envelope.event.type).toBe("MILESTONE");
  });

  it("runs a scripted tool call through Cedar into the stage's own target, with the turn's session", async () => {
    const flow = await open({ plans: planQueue([{ steps: [{ tool: "get_dossier", input: {} }], note: "reads" }]) });
    const turn = await flow.openTurn({ operationId: "op-4471", trigger: "IMPORTER_MESSAGE" });
    const scripted = await flow.harness.run({ text: turn.envelope });
    const [call] = scripted.calls;
    expect(call).toMatchObject({ tool: "get_dossier", cedar: { decision: "ALLOW" }, output: { ok: true } });
    expect(JSON.stringify(call?.output)).toContain("PACKING_LIST");
  });

  it("drains an empty queue and settles a quiet world", async () => {
    const flow = await open();
    expect(await flow.entries.drain()).toBe(0);
    await flow.entries.settle();
    expect(flow.aws.queue.deadLetters).toEqual([]);
  });
});
