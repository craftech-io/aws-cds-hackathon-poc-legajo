// Asynchronous invocations of the sign-up (`InvocationType: Event`): `signup.start` and `signup.resend`
// hand the work to `SignupDispatch` and answer without waiting (ADR-0015 §1.1); `finalizeSignup` and
// the sweep hand the notice to `LeadNotice`; `leads:delete` asks `WorldJanitor` to destroy a world.
// The event is validated by the receiver; this module only knows names and payloads.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { STAGE_REGION } from "../public-web/presign";

/** Linked functions the sign-up invokes (`Resource.<Name>.name`). */
export const ASYNC_TARGETS = ["SignupDispatch", "LeadNotice", "WorldJanitor"] as const;
export type AsyncTarget = (typeof ASYNC_TARGETS)[number];

export interface AsyncInvoker {
  /** Queues `payload` for `target`; resolves once Lambda accepted it (202), never after the work. */
  invoke(target: AsyncTarget, payload: Readonly<Record<string, unknown>>): Promise<void>;
}

// Accepting an asynchronous event takes milliseconds; the BFF answers the visitor right after.
const INVOKE_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 2_000, connectionTimeoutMs: 1_000, maxAttempts: 2 };
const RETRYABLE = new Set(["TooManyRequestsException", "ServiceException", "EC2ThrottledException", "TimeoutError"]);
const FunctionLink = z.object({ name: z.string().min(1) });

export function lambdaAsyncInvoker(client = new LambdaClient({ region: STAGE_REGION, ...awsClientConfig(INVOKE_TIMEOUTS) })): AsyncInvoker {
  return {
    async invoke(target, payload) {
      const functionName = readLinked(target, FunctionLink).name;
      await withRetry(() => client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(payload)) })), {
        attempts: 3,
        baseDelayMs: 50,
        shouldRetry: (error) => RETRYABLE.has(error instanceof Error ? error.name : ""),
      });
    },
  };
}
