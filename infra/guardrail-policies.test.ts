import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARDRAIL_KINDS, GUARDRAIL_REGEXES, SENSITIVE_KINDS, maskSensitive } from "../packages/bff/src/lib/mask";
import { detectLanguage } from "../packages/bff/src/services/language";
import {
  BLOCKED_MESSAGES,
  CONTENT_FILTERS,
  DENIED_TOPICS,
  G1_POLICIES,
  G1_REGEXES,
  G2_LIMITS,
  G2_POLICIES,
  GROUNDING_FILTERS,
  GUARDRAIL_TIER,
  PII_ENTITIES,
  policiesDigest,
} from "./guardrail-policies";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

// Bedrock limits of a denied topic (CLASSIC tier) and of a custom regex.
const TOPIC_NAME = /^[0-9a-zA-Z-_ !?.]+$/;
const REGEX_NAME = /^[0-9a-zA-Z-_ !?.]+$/;

/** The quoted triggers of a flow's "Disparador" line in docs/flows-catalog.md. */
function flowTriggers(flowId: string): string[] {
  const catalog = read("docs/flows-catalog.md");
  const block = catalog.slice(catalog.indexOf(`### ${flowId} ·`));
  const line = block.split("\n").find((candidate) => candidate.includes("Disparador:")) ?? "";
  return [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/** Every quoted importer or supplier text of the catalog (`Disparador` lines). */
function catalogTexts(): string[] {
  return read("docs/flows-catalog.md")
    .split("\n")
    .filter((line) => line.includes("Disparador:"))
    .flatMap((line) => [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? ""));
}

// Where the texts that reach the normalizer live, now or once their work package lands: channel
// fixtures (.eml, .json), the supplier simulator bodies and every text of copy/, the seed data, the
// scenario and local-flow texts. A directory that does not exist yet contributes nothing.
const CORPUS_ROOTS = ["packages/bff/src/channels", "packages/bff/src/copy", "packages/bff/src/sim-mail", "scripts/seed/data", "scripts/scenarios", "tests/flows"];
const CORPUS_FILE = /\.(eml|json|txt|ts)$/;

function corpusFiles(path: string, out: string[] = []): string[] {
  let stats;
  try {
    stats = statSync(resolve(ROOT, path));
  } catch {
    return out;
  }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(resolve(ROOT, path))) if (entry !== "node_modules") corpusFiles(join(path, entry), out);
  } else if (CORPUS_FILE.test(path)) out.push(path);
  return out;
}

const g1Regexes = (): RegExp[] => (G1_POLICIES.sensitiveInformationPolicyConfig?.regexesConfigs ?? []).map((regex) => new RegExp(regex.pattern));
const firesG1Regex = (text: string): boolean => g1Regexes().some((regex) => regex.test(text));
/** What channels/normalizer.ts does to every inbound text (packages/bff/src/lib/mask.ts header). */
const normalize = (text: string): string => maskSensitive(text, SENSITIVE_KINDS).text;

describe("[FL-047] denied topics: G1 on input and output, G2 on the outbound text", () => {
  it("declares the five topics of docs/design-brief.md §5.5 within the Bedrock limits", () => {
    expect(DENIED_TOPICS.map((topic) => topic.name)).toEqual(["TariffClassification", "CustomsValuation", "DutiesAndTaxes", "DebtCollection", "LegalOrCustomsAdvice"]);
    for (const topic of DENIED_TOPICS) {
      expect(topic.name).toMatch(TOPIC_NAME);
      expect(topic.name.length).toBeLessThanOrEqual(100);
      expect(topic.definition.length).toBeGreaterThan(0);
      expect(topic.definition.length, topic.name).toBeLessThanOrEqual(200);
      const examples = [...topic.examples.es, ...topic.examples.en];
      expect(examples.length, topic.name).toBeLessThanOrEqual(5);
      for (const example of examples) expect(example.length, example).toBeLessThanOrEqual(100);
    }
  });

  it("writes every definition and example in Spanish and English, as the importer and the supplier write", () => {
    for (const topic of DENIED_TOPICS) {
      const gloss = /^(.+) \((.+)\)\.$/.exec(topic.definition);
      expect(gloss, `${topic.name}: "<es> (<en>)."`).not.toBeNull();
      expect(detectLanguage(gloss?.[1] ?? "").language, topic.name).toBe("es");
      expect(detectLanguage(gloss?.[2] ?? "").language, topic.name).toBe("en");
      expect(topic.examples.es.length, topic.name).toBeGreaterThanOrEqual(2);
      expect(topic.examples.en.length, topic.name).toBeGreaterThanOrEqual(2);
      for (const example of topic.examples.es) expect(detectLanguage(example).language, example).toBe("es");
      for (const example of topic.examples.en) expect(detectLanguage(example).language, example).toBe("en");
    }
  });

  it("teaches each trigger of FL-047 (a)-(e) to its own topic", () => {
    const triggers = flowTriggers("FL-047");
    expect(triggers).toHaveLength(5);
    triggers.forEach((trigger, index) => {
      const owners = DENIED_TOPICS.filter((topic) => topic.examples.es.includes(trigger)).map((topic) => topic.name);
      expect(owners, trigger).toEqual([DENIED_TOPICS[index]?.name]);
    });
  });

  it("sends the same DENY topics to G1 and G2 on the CLASSIC tier", () => {
    const topics = G1_POLICIES.topicPolicyConfig;
    expect(G2_POLICIES.topicPolicyConfig).toBe(topics);
    expect(topics?.tierConfigs).toEqual([{ tierName: GUARDRAIL_TIER }]);
    expect(GUARDRAIL_TIER).toBe("CLASSIC");
    expect(topics?.topicsConfigs).toEqual(
      DENIED_TOPICS.map((topic) => ({ name: topic.name, definition: topic.definition, examples: [...topic.examples.es, ...topic.examples.en], type: "DENY" })),
    );
  });
});

describe("[FL-038] [FL-051] G1 blocks only what the worker can classify (docs/architecture.md §9.1)", () => {
  it("sets prompt attack to HIGH on input and has no other content filter", () => {
    expect(CONTENT_FILTERS).toEqual([{ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" }]);
    expect(G1_POLICIES.contentPolicyConfig?.filtersConfigs).toEqual([
      { type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE", inputModalities: ["TEXT"], outputModalities: ["TEXT"] },
    ]);
    expect(G1_POLICIES.contentPolicyConfig?.tierConfigs).toEqual([{ tierName: "CLASSIC" }]);
  });

  it("can only block on a denied topic, a prompt attack or a card number", () => {
    const sensitive = G1_POLICIES.sensitiveInformationPolicyConfig;
    const blocking = [
      ...(G1_POLICIES.topicPolicyConfig?.topicsConfigs ?? []).map(() => "TOPIC"),
      ...(G1_POLICIES.contentPolicyConfig?.filtersConfigs ?? []).filter((filter) => filter.inputStrength !== "NONE" || filter.outputStrength !== "NONE").map((filter) => filter.type),
      ...(sensitive?.piiEntitiesConfigs ?? []).filter((entity) => [entity.action, entity.inputAction, entity.outputAction].includes("BLOCK")).map((entity) => entity.type),
      ...(sensitive?.regexesConfigs ?? []).filter((regex) => [regex.action, regex.inputAction, regex.outputAction].includes("BLOCK")).map((regex) => regex.name),
    ];
    expect([...new Set(blocking)].sort()).toEqual(["CREDIT_DEBIT_CARD_NUMBER", "PROMPT_ATTACK", "TOPIC"]);
    expect(Object.keys(G1_POLICIES).sort()).toEqual(["contentPolicyConfig", "sensitiveInformationPolicyConfig", "topicPolicyConfig"]);
  });
});

describe("[FL-050] sensitive data: G1 is the second layer of the normalizer and never blocks on it", () => {
  it("anonymizes CUIT/CUIL, DNI and CBU/CVU on input with mask.ts's own regexes", () => {
    expect(G1_REGEXES).toBe(GUARDRAIL_REGEXES);
    expect(G1_REGEXES.map((regex) => regex.kind)).toEqual([...GUARDRAIL_KINDS]);
    expect(G1_POLICIES.sensitiveInformationPolicyConfig?.regexesConfigs).toEqual(
      GUARDRAIL_REGEXES.map((regex) => ({
        name: regex.name,
        description: regex.description,
        pattern: regex.pattern,
        action: "ANONYMIZE",
        inputAction: "ANONYMIZE",
        inputEnabled: true,
        outputAction: "NONE",
        outputEnabled: false,
      })),
    );
  });

  it("keeps no copy of a document regex in infra/", () => {
    for (const file of ["infra/guardrail-policies.ts", "infra/guardrail.ts"]) {
      const source = read(file);
      for (const token of ["[0-9]", "\\\\d", "\\\\b", "{8}", "{14}"]) expect(source.includes(token), `${file} contains ${token}`).toBe(false);
    }
    expect(read("infra/guardrail-policies.ts")).toContain('import { GUARDRAIL_REGEXES } from "../packages/bff/src/lib/mask";');
  });

  it("fits Bedrock's custom regex rules: named, short, no lookaround, no \\d", () => {
    for (const regex of G1_REGEXES) {
      expect(regex.name).toMatch(REGEX_NAME);
      expect(regex.name.length).toBeLessThanOrEqual(100);
      expect(regex.description.length).toBeLessThanOrEqual(1000);
      expect(regex.pattern.length).toBeLessThanOrEqual(500);
      for (const unsupported of ["(?=", "(?!", "(?<=", "(?<!", "\\d"]) expect(regex.pattern.includes(unsupported), `${regex.name}: ${unsupported}`).toBe(false);
    }
  });

  it("blocks card numbers and leaves registered contacts (emails, phones) alone", () => {
    expect(PII_ENTITIES).toEqual([
      { type: "CREDIT_DEBIT_CARD_NUMBER", inputAction: "BLOCK", outputAction: "BLOCK" },
      { type: "EMAIL", inputAction: "NONE", outputAction: "NONE" },
      { type: "PHONE", inputAction: "NONE", outputAction: "NONE" },
    ]);
    for (const entity of G1_POLICIES.sensitiveInformationPolicyConfig?.piiEntitiesConfigs ?? []) expect(entity.action).toBe(entity.inputAction);
  });

  it("has the normalizer mask every kind G1 anonymizes, first", () => {
    for (const kind of GUARDRAIL_KINDS) expect(SENSITIVE_KINDS).toContain(kind);
    const [trigger] = flowTriggers("FL-050");
    expect(firesG1Regex(trigger ?? "")).toBe(true);
    expect(firesG1Regex(normalize(trigger ?? ""))).toBe(false);
  });

  it("lets no normalized fixture, copy text or catalog text trigger a G1 regex", () => {
    const files = CORPUS_ROOTS.flatMap((root) => corpusFiles(root));
    const texts = [...catalogTexts(), ...files.map(read)];
    expect(files.length).toBeGreaterThan(0);
    expect(texts.some(firesG1Regex), "the corpus must exercise the regexes before normalization").toBe(true);
    const offenders = [...catalogTexts().map((text) => ({ source: `docs/flows-catalog.md "${text}"`, text })), ...files.map((file) => ({ source: file, text: read(file) }))].filter(
      ({ text }) => firesG1Regex(normalize(text)),
    );
    expect(offenders.map(({ source }) => source)).toEqual([]);
  });
});

describe("grounding (G2)", () => {
  it("uses grounding 0.75 and relevance 0.5 and nothing that rewrites the outbound text", () => {
    expect(GROUNDING_FILTERS).toEqual([
      { type: "GROUNDING", threshold: 0.75 },
      { type: "RELEVANCE", threshold: 0.5 },
    ]);
    expect(G2_POLICIES.contextualGroundingPolicyConfig?.filtersConfigs).toEqual([...GROUNDING_FILTERS]);
    expect(Object.keys(G2_POLICIES).sort()).toEqual(["contextualGroundingPolicyConfig", "topicPolicyConfig"]);
  });

  it("states the input limits of docs/architecture.md §9.4", () => {
    expect(G2_LIMITS).toEqual({ queryMaxChars: 1_000, groundingSourceMaxChars: 100_000, contentMaxChars: 5_000 });
  });
});

describe("versions and blocked messages", () => {
  it("publishes a new version whenever a policy changes", () => {
    expect(policiesDigest(G1_POLICIES)).toMatch(/^[0-9a-f]{16}$/);
    expect(policiesDigest(G1_POLICIES)).toBe(policiesDigest(structuredClone(G1_POLICIES)));
    expect(policiesDigest(G1_POLICIES)).not.toBe(policiesDigest(G2_POLICIES));
    const changed = { ...G2_POLICIES, contextualGroundingPolicyConfig: { filtersConfigs: [{ type: "GROUNDING", threshold: 0.7 }] } };
    expect(policiesDigest(changed)).not.toBe(policiesDigest(G2_POLICIES));
  });

  it("uses sentinels that could never pass the outbound language check", () => {
    const messages = Object.values(BLOCKED_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(500);
      expect(detectLanguage(message).language).toBe("und");
    }
  });
});
