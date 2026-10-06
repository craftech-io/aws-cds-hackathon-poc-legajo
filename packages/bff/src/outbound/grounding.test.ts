// G2 on the way out (docs/design-brief.md §5.5, docs/architecture.md §9.4; FL-045): what `ApplyGuardrail`
// reads (the turn's results and the checklist as grounding source, the importer's question or the
// kind's description as query, the text whole), the limits of each part, the verdict with the
// thresholds (relevance only for a `REPLY`) and the failure that fails closed.
import { ApplyGuardrailCommand, type ApplyGuardrailCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { MessageKind } from "@legajo/shared";
import { type G2Config, GuardrailUnavailableError, STATUS_QUERY, asksSomething, contentBlocks, createBedrockG2, groundingSourceOf, queryOf, verdictOf } from "./grounding";

const CONFIG: G2Config = { id: "g2-id", version: "3", groundingThreshold: 0.8, relevanceThreshold: 0.7, queryMaxChars: 40, groundingSourceMaxChars: 120, contentMaxChars: 200 };

function assessed(grounding?: number, relevance?: number, extra: Record<string, unknown> = {}): Pick<ApplyGuardrailCommandOutput, "action" | "assessments"> {
  const filters = [
    ...(grounding === undefined ? [] : [{ type: "GROUNDING" as const, score: grounding, threshold: 0.8, action: grounding < 0.8 ? ("BLOCKED" as const) : ("NONE" as const) }]),
    ...(relevance === undefined ? [] : [{ type: "RELEVANCE" as const, score: relevance, threshold: 0.7, action: "NONE" as const }]),
  ];
  return { action: "NONE", assessments: [{ contextualGroundingPolicy: { filters }, ...extra }] };
}

describe("[FL-045] what G2 reads", () => {
  it("a REPLY is scored against the importer's question; every other kind against its own description", () => {
    expect(queryOf("REPLY", "  ¿Qué tiene que tener el certificado de origen?  ", 1000)).toBe("¿Qué tiene que tener el certificado de origen?");
    expect(queryOf("REPLY", undefined, 1000)).toBe("What did the importer ask?");
    expect(queryOf("DOCS_REQUEST", "ignored", 1000)).toBe("Which documents of this import operation are missing and who has to send them?");
    for (const kind of MessageKind.options) expect(queryOf(kind, undefined, 1000).length).toBeGreaterThan(10);
    expect(queryOf("REPLY", "x".repeat(500), 40)).toHaveLength(40);
  });

  it("a REPLY to small talk is scored against the status of the operation (ADR-0019)", () => {
    for (const greeting of ["hola", "  Hola!  ", "ok gracias", "buen día che"]) expect(queryOf("REPLY", greeting, 1000)).toBe(STATUS_QUERY);
    expect(queryOf("REPLY", "¿llegó?", 1000)).toBe("¿llegó?");
    expect(queryOf("REPLY", "cuando llega el barco al puerto", 1000)).toBe("cuando llega el barco al puerto");
    expect(asksSomething("hola")).toBe(false);
    expect(asksSomething("qué falta?")).toBe(true);
  });

  it("the grounding source keeps the newest results whole and clips from the oldest side", () => {
    const sources = [
      { tool: "checklist", output: { text: "Firmado y sellado por la entidad emisora" } },
      { tool: "get_dossier", output: { etaText: "22/10" } },
    ];
    const full = groundingSourceOf(sources, 10_000);
    expect(full.split("\n")).toEqual([JSON.stringify(sources[0]), JSON.stringify(sources[1])]);
    const clipped = groundingSourceOf(sources, 50);
    expect(clipped).toHaveLength(50);
    expect(full.endsWith(clipped)).toBe(true);
  });

  it("the three blocks carry their qualifiers and the limits; the text goes whole", () => {
    const blocks = contentBlocks({ kind: "REPLY", text: "El certificado tiene que estar firmado y sellado.", groundingSource: "s".repeat(500), query: "q".repeat(100) }, CONFIG);
    expect(blocks.map((block) => block.text?.qualifiers)).toEqual([["grounding_source"], ["query"], ["guard_content"]]);
    expect(blocks[0]?.text?.text).toHaveLength(120);
    expect(blocks[1]?.text?.text).toHaveLength(40);
    expect(blocks[2]?.text?.text).toBe("El certificado tiene que estar firmado y sellado.");
    expect(contentBlocks({ kind: "REPLY", text: "x", groundingSource: "", query: "" }, CONFIG).map((block) => block.text?.text)).toEqual(["{}", "-", "x"]);
  });
});

describe("[FL-045] the verdict", () => {
  it("grounding always, relevance only for a REPLY", () => {
    expect(verdictOf(assessed(0.95, 0.9), "REPLY", CONFIG)).toEqual({ action: "NONE", groundingScore: 0.95, relevanceScore: 0.9 });
    expect(verdictOf(assessed(0.5, 0.9), "REPLY", CONFIG)).toMatchObject({ action: "BLOCKED", failure: "GROUNDING" });
    expect(verdictOf(assessed(0.95, 0.3), "REPLY", CONFIG)).toMatchObject({ action: "BLOCKED", failure: "RELEVANCE" });
    expect(verdictOf(assessed(0.95, 0.3), "DOCS_REQUEST", CONFIG)).toMatchObject({ action: "NONE" });
  });

  it("no grounding score checked nothing, and fails closed", () => {
    expect(verdictOf(assessed(undefined, 0.9), "REPLY", CONFIG)).toMatchObject({ action: "BLOCKED", failure: "GROUNDING" });
  });

  it("a denied topic or word of the output policy blocks", () => {
    const blocked = { ...assessed(0.95, 0.9, { topicPolicy: { topics: [{ name: "Customs duties", type: "DENY", action: "BLOCKED" }] } }), action: "GUARDRAIL_INTERVENED" as const };
    expect(verdictOf(blocked, "REPLY", CONFIG)).toMatchObject({ action: "BLOCKED", failure: "BLOCKED" });
  });
});

describe("[FL-045] the Bedrock client", () => {
  it("sends source OUTPUT with the published version, and never half-checks a long text", async () => {
    const sent: ApplyGuardrailCommand[] = [];
    const g2 = createBedrockG2({ client: { send: async (command: unknown) => (sent.push(command as ApplyGuardrailCommand), assessed(0.9, 0.9)) } as never, config: () => CONFIG, sleep: async () => {} });
    expect(await g2.check({ kind: "REPLY", text: "Sí, firmado y sellado.", groundingSource: "{}", query: "¿Firmado?" })).toMatchObject({ action: "NONE" });
    expect(sent[0]?.input).toMatchObject({ guardrailIdentifier: "g2-id", guardrailVersion: "3", source: "OUTPUT" });
    expect(await g2.check({ kind: "REPLY", text: "x".repeat(201), groundingSource: "{}", query: "q" })).toEqual({ action: "BLOCKED", failure: "TOO_LONG" });
    expect(sent).toHaveLength(1);
  });

  it("retries a throttle once, then fails closed as unavailable", async () => {
    let calls = 0;
    const throttled = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    const g2 = createBedrockG2({ client: { send: async () => ((calls += 1), Promise.reject(throttled)) } as never, config: () => CONFIG, sleep: async () => {} });
    await expect(g2.check({ kind: "REPLY", text: "Hola", groundingSource: "{}", query: "q" })).rejects.toBeInstanceOf(GuardrailUnavailableError);
    expect(calls).toBe(2);
  });
});
