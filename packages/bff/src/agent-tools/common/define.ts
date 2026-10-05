// How a Gateway tool is declared (docs/tool-catalog.md, docs/design-brief.md §5.3 and §5.6). One zod
// definition per tool is the single source of:
//
//   - the Gateway schema the model reads (`gatewayInput`: `sessionToken` plus the tool's fields, turned
//     into the `inlinePayload` of its target by gateway-schema.ts / `npm run tools:build-schemas`);
//   - the strict input the target Lambda accepts from the Gateway (`LAM-STRICT`: an undeclared key, a
//     value out of the real enum or a field Cedar forbids → `INVALID`);
//   - the strict input of a direct, in-process call (`directInput`: `caller` and the operation instead of
//     `sessionToken`, with the wider values a deterministic caller may use);
//   - who else may call it besides the Harness (`LAM-CALLER`) and in which turns (`LAM-TRIGGER`).
//
// Pure on purpose (zod and @legajo/shared only): infra/agent-tool-schemas.ts loads the definitions in the
// SST program, so nothing here may reach the connector, the SDKs or `Resource`.
import { z } from "zod";
import { Caller, type CallerKind, type CedarStatementId, type GatewayToolName, OperationId, SessionToken, type TurnTrigger } from "@legajo/shared";

/** JSON types a node of a Gateway schema may declare (`SchemaDefinition.type`). */
export type GatewayType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export interface DeniedField {
  readonly type: GatewayType;
  readonly ruleId: CedarStatementId;
}

const DENIED_FIELDS = new WeakMap<object, DeniedField>();

/**
 * A field a Cedar forbid reads (`decision` for CED-NO-APPROVE, `overrideAssumptions` for
 * CED-RISK-ASSUMPTIONS). Cedar validates every statement against the Gateway schema and skips a forbid
 * that reads an undeclared field, so the field is declared there, optional and documented as never set;
 * zod rejects it with any value, so the Lambda refuses it even without Cedar (`LAM-STRICT`).
 */
export function deniedByPolicy(type: GatewayType, ruleId: CedarStatementId) {
  const schema = z.never().optional().describe(`never set; denied by policy ${ruleId}`);
  DENIED_FIELDS.set(schema, { type, ruleId });
  return schema;
}

/** The Gateway declaration of a field made with `deniedByPolicy`, if it is one. */
export function deniedFieldOf(schema: object): DeniedField | undefined {
  return DENIED_FIELDS.get(schema);
}

/** Free text of bounded length; the bound reaches the model through the field's description. */
export function boundedText(max: number, description: string) {
  return z.string().trim().min(1).max(max).describe(description);
}

/** What the model reads about `sessionToken`, the same on the 16 tools. */
export const SESSION_TOKEN_DESCRIPTION = 'Token of this turn, copied verbatim from the <session token="…"/> line of the turn envelope. Required in every call; never write it yourself.';

/** Callers of the console and of the `QaDriver` (which reaches the console handlers through the real appRouter). */
export const CONSOLE_CALLERS = ["CONSOLE", "QA"] as const satisfies readonly CallerKind[];

export interface ToolSpec<N extends GatewayToolName, S extends z.ZodRawShape, D extends z.ZodRawShape> {
  readonly name: N;
  /** What the model reads about the tool (the Gateway `description`). */
  readonly description: string;
  /** Arguments the model may write, besides `sessionToken`. */
  readonly fields: S;
  /** Direct callers besides the Harness, as docs/tool-catalog.md lists them ("invocan"). */
  readonly callers: readonly CallerKind[];
  /** Fields a direct caller may write differently (a wider enum), merged over `fields`. */
  readonly directFields?: D;
  /**
   * `LAM-TRIGGER`: the turn triggers a Harness call is allowed in, read from the session and never
   * from the input; `undefined` allows any. Direct callers are deterministic code and have no trigger.
   */
  triggers?(input: z.output<z.ZodObject<S>>): readonly TurnTrigger[] | undefined;
}

export interface ToolDefinition<N extends GatewayToolName = GatewayToolName, S extends z.ZodRawShape = z.ZodRawShape, D extends z.ZodRawShape = z.ZodRawShape>
  extends ToolSpec<N, S, D> {
  /** What the Gateway sends: `sessionToken` plus `fields`, strict. */
  readonly gatewayInput: z.ZodObject;
  /** What a direct caller sends: `caller`, `operationId`, `fields` and `directFields`, strict. */
  readonly directInput: z.ZodObject;
  /** Names of the fields declared with `deniedByPolicy`. */
  readonly deniedFields: readonly string[];
}

/** Keys of the principal and of the scope; the implementation never sees them in its input. */
export const PRINCIPAL_KEYS = ["sessionToken", "caller", "operationId"] as const;

export function defineTool<const N extends GatewayToolName, S extends z.ZodRawShape, D extends z.ZodRawShape = Record<never, never>>(
  spec: ToolSpec<N, S, D>,
): ToolDefinition<N, S, D> {
  for (const key of PRINCIPAL_KEYS) {
    if (key in spec.fields || key in (spec.directFields ?? {})) throw new Error(`${spec.name}: "${key}" is set by the wrapper, not declared by the tool`);
  }
  const deniedFields = Object.entries(spec.fields)
    .filter(([, schema]) => deniedFieldOf(schema) !== undefined)
    .map(([field]) => field);
  return {
    ...spec,
    gatewayInput: z.object({ sessionToken: SessionToken.describe(SESSION_TOKEN_DESCRIPTION), ...spec.fields }).strict(),
    directInput: z.object({ caller: Caller, operationId: OperationId, ...spec.fields, ...(spec.directFields ?? {}) }).strict(),
    deniedFields,
  };
}

/** The input an implementation receives: the tool's own fields, the direct ones taking precedence. */
export type ToolInput<T> =
  T extends ToolDefinition<GatewayToolName, infer S extends z.ZodRawShape, infer D extends z.ZodRawShape> ? z.output<z.ZodObject<Omit<S, keyof D> & D>> : never;
