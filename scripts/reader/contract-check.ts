// Keeps the document reader's contract in one shape (ADR-0003, docs/architecture.md §18): the
// OpenAPI file packages/reader-contract/openapi.yaml, its zod mirror (@legajo/reader-contract) and
// the schemas the mock (packages/reader-mock/src/app.ts) and the client
// (packages/bff/src/reader/client.ts) actually validate with.
//
//   1. Every component schema, parameter and response header of the YAML has a zod twin with the
//      same structure: types, formats, enums, patterns, bounds, required keys and properties.
//      Both sides go through JSON Schema (`z.toJSONSchema`) and one canonical form; descriptions
//      are ignored and an unknown keyword fails instead of being skipped.
//   2. The operations of the YAML are exactly those of `READER_OPERATIONS`: method, path,
//      operationId, parameters, request body, status codes, response bodies and headers.
//   3. The schema sets of the mock and the client are equal to the YAML components they name.
//
//   npm run reader:contract
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { READER_OPERATIONS, READER_PARAMETERS, READER_RESPONSE_HEADERS, READER_SCHEMAS, type ReaderOperationSpec } from "@legajo/reader-contract";
import { READER_MOCK_SCHEMAS } from "@legajo/reader-mock/app";
import { READER_CLIENT_SCHEMAS } from "@legajo/bff/reader/client";

export const OPENAPI_FILE = "packages/reader-contract/openapi.yaml";

export interface ContractSources {
  /** Text of the OpenAPI file. */
  readonly yaml: string;
  readonly schemas: Readonly<Record<string, z.ZodType>>;
  readonly parameters: Readonly<Record<string, { readonly name: string; readonly in: string; readonly required: boolean; readonly schema: z.ZodType }>>;
  readonly responseHeaders: Readonly<Record<string, { readonly name: string; readonly schema: z.ZodType }>>;
  readonly operations: Readonly<Record<string, ReaderOperationSpec>>;
  /** Schema sets of the implementations (`mock`, `client`), by component name. */
  readonly implementations: Readonly<Record<string, Readonly<Record<string, z.ZodType>>>>;
}

type Node = Readonly<Record<string, unknown>>;

const IGNORED = new Set(["description", "summary", "title", "$schema", "example", "examples"]);
const HANDLED = new Set(["type", "format", "pattern", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "required", "properties", "items", "additionalProperties", "$ref"]);
const JSON_TYPE = "application/json";

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function child(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) current = isNode(current) ? current[key] : undefined;
  return current;
}

function refName(ref: unknown, kind: string): string | undefined {
  const prefix = `#/components/${kind}/`;
  return typeof ref === "string" && ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

/**
 * One canonical form for a JSON Schema from either side: `$ref` resolved, `const` as a one-value
 * `enum`, zod's safe-integer bounds and a `pattern` that only restates a `format` dropped, `required`
 * sorted. Throws on a keyword it does not know, so nothing is compared by accident.
 */
export function canonicalSchema(schema: unknown, root: unknown, where: string): Node {
  if (!isNode(schema)) throw new Error(`${where}: not a schema`);
  if (schema.$ref !== undefined) {
    const name = refName(schema.$ref, "schemas");
    const target = name === undefined ? undefined : child(root, "components", "schemas", name);
    if (target === undefined) throw new Error(`${where}: unresolved $ref ${String(schema.$ref)}`);
    return canonicalSchema(target, root, where);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (IGNORED.has(key)) continue;
    if (!HANDLED.has(key)) throw new Error(`${where}: unsupported keyword "${key}"`);
    if (key === "pattern" && schema.format !== undefined) continue;
    if ((key === "minimum" || key === "maximum") && schema.type === "integer" && Math.abs(Number(value)) === Number.MAX_SAFE_INTEGER) continue;
    if (key === "const") out.enum = [value];
    else if (key === "required") {
      if (Array.isArray(value) && value.length > 0) out.required = [...value].map(String).sort();
    } else if (key === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(isNode(value) ? value : {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, property]) => [name, canonicalSchema(property, root, `${where}.${name}`)]),
      );
    } else if (key === "items") out.items = canonicalSchema(value, root, `${where}[]`);
    else if (key === "additionalProperties") out.additionalProperties = isNode(value) ? canonicalSchema(value, root, `${where}{}`) : value;
    else out[key] = value;
  }
  return out;
}

export function zodSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: "input", target: "draft-2020-12", unrepresentable: "throw" });
}

/** Differences between two canonical schemas, one line per path. */
export function schemaDiff(yaml: unknown, zod: unknown, path: string): string[] {
  if (isNode(yaml) && isNode(zod)) {
    const keys = [...new Set([...Object.keys(yaml), ...Object.keys(zod)])].sort();
    return keys.flatMap((key) => schemaDiff(yaml[key], zod[key], `${path}.${key}`));
  }
  if (JSON.stringify(yaml) === JSON.stringify(zod)) return [];
  return [`${path}: YAML ${JSON.stringify(yaml) ?? "(absent)"} / zod ${JSON.stringify(zod) ?? "(absent)"}`];
}

function compareSchema(label: string, yamlSchema: unknown, schema: z.ZodType, root: unknown): string[] {
  try {
    return schemaDiff(canonicalSchema(yamlSchema, root, `${label} (YAML)`), canonicalSchema(zodSchema(schema), {}, `${label} (zod)`), label);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function sameSet(label: string, yamlNames: readonly string[], zodNames: readonly string[]): string[] {
  const missing = yamlNames.filter((name) => !zodNames.includes(name)).map((name) => `${label}: "${name}" is in the YAML but not in zod`);
  const extra = zodNames.filter((name) => !yamlNames.includes(name)).map((name) => `${label}: "${name}" is in zod but not in the YAML`);
  return [...missing, ...extra];
}

function checkComponents(root: unknown, sources: ContractSources): string[] {
  const errors: string[] = [];
  const yamlSchemas = child(root, "components", "schemas");
  errors.push(...sameSet("components.schemas", Object.keys(isNode(yamlSchemas) ? yamlSchemas : {}), Object.keys(sources.schemas)));
  for (const [name, schema] of Object.entries(sources.schemas)) {
    const yamlSchema = child(yamlSchemas, name);
    if (yamlSchema !== undefined) errors.push(...compareSchema(`schemas.${name}`, yamlSchema, schema, root));
  }
  const yamlParameters = child(root, "components", "parameters");
  errors.push(...sameSet("components.parameters", Object.keys(isNode(yamlParameters) ? yamlParameters : {}), Object.keys(sources.parameters)));
  for (const [name, spec] of Object.entries(sources.parameters)) {
    const parameter = child(yamlParameters, name);
    if (parameter === undefined) continue;
    const declared = { name: child(parameter, "name"), in: child(parameter, "in"), required: child(parameter, "required") ?? false };
    errors.push(...schemaDiff(declared, { name: spec.name, in: spec.in, required: spec.required }, `parameters.${name}`));
    errors.push(...compareSchema(`parameters.${name}.schema`, child(parameter, "schema"), spec.schema, root));
  }
  const yamlHeaders = child(root, "components", "headers");
  errors.push(...sameSet("components.headers", Object.keys(isNode(yamlHeaders) ? yamlHeaders : {}), Object.keys(sources.responseHeaders)));
  for (const [name, spec] of Object.entries(sources.responseHeaders)) {
    const header = child(yamlHeaders, name);
    if (header !== undefined) errors.push(...compareSchema(`headers.${name}.schema`, child(header, "schema"), spec.schema, root));
  }
  return errors;
}

function jsonSchemaRef(content: unknown): string | undefined {
  return refName(child(content, JSON_TYPE, "schema", "$ref"), "schemas");
}

function checkOperation(root: unknown, id: string, spec: ReaderOperationSpec, sources: ContractSources): string[] {
  const operation = child(root, "paths", spec.path, spec.method);
  const where = `${spec.method.toUpperCase()} ${spec.path}`;
  if (!isNode(operation)) return [`${where}: operation "${id}" is not in the YAML`];
  const errors: string[] = [];
  if (operation.operationId !== id) errors.push(`${where}: operationId YAML ${String(operation.operationId)} / zod ${id}`);
  const parameters = Array.isArray(operation.parameters) ? operation.parameters.map((parameter: unknown) => refName(child(parameter, "$ref"), "parameters") ?? "(inline)") : [];
  errors.push(...schemaDiff(parameters, [...spec.parameters], `${where} parameters`));
  const body = jsonSchemaRef(child(operation, "requestBody", "content"));
  errors.push(...schemaDiff(body, spec.requestBody, `${where} requestBody`));
  if (spec.requestBody !== undefined && child(operation, "requestBody", "required") !== true) errors.push(`${where}: requestBody must be required`);
  const responses = child(operation, "responses");
  const codes = Object.keys(isNode(responses) ? responses : {});
  errors.push(...sameSet(`${where} responses`, codes, Object.keys(spec.responses)));
  for (const [code, schemaName] of Object.entries(spec.responses)) {
    const response = child(responses, code);
    if (response === undefined) continue;
    errors.push(...schemaDiff(jsonSchemaRef(child(response, "content")), schemaName, `${where} ${code} body`));
    const headers = child(response, "headers");
    const declared = Object.entries(isNode(headers) ? headers : {}).map(([wire, header]) => `${wire}=${refName(child(header, "$ref"), "headers") ?? "(inline)"}`);
    const expected = (spec.responseHeaders?.[code] ?? []).map((name) => `${sources.responseHeaders[name]?.name ?? "?"}=${name}`);
    errors.push(...schemaDiff(declared.sort(), [...expected].sort(), `${where} ${code} headers`));
  }
  return errors;
}

function checkOperations(root: unknown, sources: ContractSources): string[] {
  const errors = Object.entries(sources.operations).flatMap(([id, spec]) => checkOperation(root, id, spec, sources));
  const paths = child(root, "paths");
  const declared = Object.entries(isNode(paths) ? paths : {}).flatMap(([path, item]) => Object.keys(isNode(item) ? item : {}).map((method) => `${method} ${path}`));
  const known = Object.values(sources.operations).map((spec) => `${spec.method} ${spec.path}`);
  errors.push(...sameSet("paths", declared, known));
  return errors;
}

function checkImplementations(root: unknown, sources: ContractSources): string[] {
  return Object.entries(sources.implementations).flatMap(([owner, schemas]) =>
    Object.entries(schemas).flatMap(([name, schema]) => {
      const yamlSchema = child(root, "components", "schemas", name);
      if (yamlSchema === undefined) return [`${owner}: validates with "${name}", which is not a component of the YAML`];
      return compareSchema(`${owner}.${name}`, yamlSchema, schema, root);
    }),
  );
}

/** Every difference between the YAML and the zod side; empty when they agree. */
export function checkReaderContract(sources: ContractSources): string[] {
  let root: unknown;
  try {
    root = parse(sources.yaml);
  } catch (error) {
    return [`${OPENAPI_FILE}: not valid YAML (${error instanceof Error ? error.message : String(error)})`];
  }
  if (child(root, "openapi") !== "3.1.0") return [`${OPENAPI_FILE}: expected openapi 3.1.0`];
  return [...checkComponents(root, sources), ...checkOperations(root, sources), ...checkImplementations(root, sources)];
}

export function defaultSources(cwd: string): ContractSources {
  return {
    yaml: readFileSync(join(cwd, OPENAPI_FILE), "utf8"),
    schemas: READER_SCHEMAS,
    parameters: READER_PARAMETERS,
    responseHeaders: READER_RESPONSE_HEADERS,
    operations: READER_OPERATIONS,
    implementations: { mock: READER_MOCK_SCHEMAS, client: READER_CLIENT_SCHEMAS },
  };
}

function main(): void {
  const errors = checkReaderContract(defaultSources(process.cwd()));
  if (errors.length > 0) {
    console.error(`reader:contract: ${errors.length} difference(s) between ${OPENAPI_FILE} and the zod schemas:`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const counts = `${Object.keys(READER_SCHEMAS).length} schemas, ${Object.keys(READER_OPERATIONS).length} operations`;
  console.log(`reader:contract: ${OPENAPI_FILE} and the zod schemas of the contract, the mock and the client agree (${counts}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
