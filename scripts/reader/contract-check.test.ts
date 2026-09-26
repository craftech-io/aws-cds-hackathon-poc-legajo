import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Reading } from "@legajo/reader-contract";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { canonicalSchema, checkReaderContract, defaultSources, schemaDiff, zodSchema, type ContractSources } from "./contract-check";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REAL = defaultSources(ROOT);

type Doc = Record<string, any>;

/** The real sources with the YAML changed by `mutate`. */
function withYaml(mutate: (doc: Doc) => void): ContractSources {
  const doc = parse(REAL.yaml) as Doc;
  mutate(doc);
  return { ...REAL, yaml: stringify(doc) };
}

function problems(sources: ContractSources): string {
  return checkReaderContract(sources).join("\n");
}

describe("reader:contract · the committed contract", () => {
  it("finds no difference between openapi.yaml and the zod schemas of the contract, the mock and the client", () => {
    expect(checkReaderContract(REAL)).toEqual([]);
  });

  it("compares for real: both sides reach the same canonical form, field by field", () => {
    const doc = parse(REAL.yaml) as Doc;
    const fromYaml = canonicalSchema(doc.components.schemas.Reading, doc, "yaml");
    expect(fromYaml).toEqual(canonicalSchema(zodSchema(Reading), {}, "zod"));
    expect(Object.keys(fromYaml.properties as object)).toHaveLength(10);
    expect(schemaDiff({ type: "string" }, { type: "number" }, "x")).toEqual(['x.type: YAML "string" / zod "number"']);
  });
});

describe("reader:contract · drift in the YAML", () => {
  it("fails on an enum value, a required key or a property that only one side has", () => {
    const enumDrift = withYaml((doc) => {
      doc.components.schemas.ReadingObservation.properties.code.enum = doc.components.schemas.ReadingObservation.properties.code.enum.filter((code: string) => code !== "LOW_CONFIDENCE");
    });
    expect(problems(enumDrift)).toContain("schemas.ReadingObservation.properties.code.enum");
    const requiredDrift = withYaml((doc) => {
      doc.components.schemas.Reading.required = ["readingId", "status"];
    });
    expect(problems(requiredDrift)).toContain("schemas.Reading.required");
    const extraProperty = withYaml((doc) => {
      doc.components.schemas.ReadingFields.properties.hsCode = { type: "string" };
    });
    expect(problems(extraProperty)).toContain("schemas.ReadingFields.properties.hsCode");
  });

  it("fails on a keyword it cannot compare instead of skipping it", () => {
    const sources = withYaml((doc) => {
      doc.components.schemas.Health.oneOf = [{ type: "object" }];
    });
    expect(problems(sources)).toContain('unsupported keyword "oneOf"');
  });

  it("fails on operations, status codes, parameters and headers that differ", () => {
    expect(problems(withYaml((doc) => delete doc.paths["/v1/readings"].post.responses["413"]))).toContain("POST /v1/readings responses");
    expect(problems(withYaml((doc) => (doc.paths["/v1/extract"] = { post: { operationId: "extract", responses: {} } })))).toContain('"post /v1/extract" is in the YAML but not in zod');
    expect(problems(withYaml((doc) => (doc.components.parameters.IdempotencyKey.required = false)))).toContain("parameters.IdempotencyKey.required");
    expect(problems(withYaml((doc) => delete doc.paths["/v1/readings"].post.responses["503"].headers))).toContain("POST /v1/readings 503 headers");
    expect(problems(withYaml((doc) => (doc.paths["/v1/health"].get.operationId = "ping")))).toContain("operationId");
    expect(problems(withYaml((doc) => delete doc.paths["/v1/readings"].post.requestBody))).toContain("requestBody");
  });

  it("fails on a file that is not YAML or not OpenAPI 3.1", () => {
    expect(problems({ ...REAL, yaml: "openapi: [" })).toContain("not valid YAML");
    expect(problems({ ...REAL, yaml: "openapi: 3.0.3\n" })).toContain("expected openapi 3.1.0");
  });
});

describe("reader:contract · drift in the zod side", () => {
  it("fails when the client or the mock validates with a schema that is not the YAML's", () => {
    const loose = { ...REAL, implementations: { ...REAL.implementations, client: { Reading: Reading.extend({ guessedType: z.string() }) } } };
    expect(problems(loose)).toContain("client.Reading.properties.guessedType");
    const strict = { ...REAL, implementations: { mock: { Reading: Reading.strict() } } };
    expect(problems(strict)).toContain("mock.Reading.additionalProperties");
    const unknown = { ...REAL, implementations: { mock: { Extraction: z.object({}) } } };
    expect(problems(unknown)).toContain('mock: validates with "Extraction"');
  });

  it("fails when the contract's zod mirror loses a schema or an operation", () => {
    const { Health: _health, ...withoutHealth } = REAL.schemas;
    expect(problems({ ...REAL, schemas: withoutHealth })).toContain('components.schemas: "Health" is in the YAML but not in zod');
    const extraOperation = { ...REAL, operations: { ...REAL.operations, deleteReading: { method: "get", path: "/v1/readings/{readingId}/raw", parameters: [], responses: {} } as const } };
    expect(problems(extraOperation)).toContain('operation "deleteReading" is not in the YAML');
  });
});
