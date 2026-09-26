// What a target Lambda runs with, built once per container on its first invocation: the DynamoDB
// connector, the `session` subkey of `SessionTokenKey` (lib/secrets.ts reads it through `Resource`,
// never `process.env`) and real time. Each target's index.ts exports `handler = lambdaEntry(create…)`,
// the entry infra/agent-tools.ts points its Function at.
import { connector } from "../../connector/index";
import { createLogger } from "../../lib/log";
import { subkey } from "../../lib/secrets";
import type { LambdaContextLike } from "./principal";
import type { GatewayTargetRuntime, ToolDeps } from "./handler";
import type { ToolResponse } from "./context";

export function productionToolDeps(): ToolDeps {
  return {
    connector: connector(),
    sessionKey: () => subkey("session"),
    wallClock: () => new Date(),
    loggerFor: (correlationId) => createLogger({ correlationId }),
  };
}

export type ToolLambdaHandler = (event: unknown, context?: LambdaContextLike) => Promise<ToolResponse>;

/** The Lambda entry of a target; nothing is built at import time, so a test can import the module freely. */
export function lambdaEntry(create: (deps: ToolDeps) => GatewayTargetRuntime): ToolLambdaHandler {
  let target: GatewayTargetRuntime | undefined;
  return (event, context) => {
    target ??= create(productionToolDeps());
    return target.handle(event, context);
  };
}
