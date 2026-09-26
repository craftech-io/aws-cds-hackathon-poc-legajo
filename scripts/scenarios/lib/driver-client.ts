// The runner's only way into the stage: `lambda:InvokeFunction` of the `QaDriver` with the credentials
// of the environment (the `qa-runner` role through OIDC in CI, or the operator's `craftech-demos`
// profile from a laptop; never a human console credential, ADR-0005). A transport failure is retried
// with backoff under the same idempotency key, so the driver replays instead of acting twice. Inputs
// and results are never logged: they can carry synthetic addresses of the world.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { QA_DRIVER_FUNCTION_NAME, type QaActionName, type QaResponse, QaResponseSchema } from "@legajo/bff/qa-driver/contract";

export type Invoke = (payload: string) => Promise<{ readonly statusCode: number; readonly functionError?: string; readonly payload: string }>;

export interface DriverClientOptions {
  readonly invoke?: Invoke;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface DriverClient {
  call(action: QaActionName, input: unknown, idempotencyKey: string): Promise<QaResponse>;
}

/** A Lambda error or a throttle: worth another try under the same key. */
export class TransportError extends Error {
  override readonly name = "TransportError";
}

// The driver may wait up to 14 minutes (Memory extraction, settle): the client waits a little longer.
const INVOKE_TIMEOUT_MS = 15 * 60_000;

export function lambdaInvoke(functionName: string = QA_DRIVER_FUNCTION_NAME, region = "us-east-1"): Invoke {
  const client = new LambdaClient({ region, maxAttempts: 3, requestHandler: new NodeHttpHandler({ requestTimeout: INVOKE_TIMEOUT_MS, connectionTimeout: 5_000 }) });
  return async (payload) => {
    const answer = await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: new TextEncoder().encode(payload) }));
    return { statusCode: answer.StatusCode ?? 0, ...(answer.FunctionError ? { functionError: answer.FunctionError } : {}), payload: new TextDecoder().decode(answer.Payload ?? new Uint8Array()) };
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createDriverClient(options: DriverClientOptions = {}): DriverClient {
  let invoke = options.invoke;
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  return {
    async call(action, input, idempotencyKey) {
      invoke ??= lambdaInvoke();
      const payload = JSON.stringify({ action, idempotencyKey, input });
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const answer = await invoke(payload);
          if (answer.functionError !== undefined || answer.statusCode >= 500) throw new TransportError(`the QA driver failed (${answer.functionError ?? answer.statusCode})`);
          return QaResponseSchema.parse(JSON.parse(answer.payload)) as QaResponse;
        } catch (error) {
          lastError = error;
          const retryable = error instanceof TransportError || (error instanceof Error && /Throttl|TooManyRequests|ECONNRESET|socket hang up/i.test(`${error.name} ${error.message}`));
          if (!retryable || attempt === attempts - 1) break;
          await sleep(Math.min(8_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 250));
        }
      }
      throw lastError instanceof Error ? lastError : new TransportError(String(lastError));
    },
  };
}
