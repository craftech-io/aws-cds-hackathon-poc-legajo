// How the rest of the stage reaches `SimMail` (its name from the link, `Resource.SimMail.name`, never
// `process.env`):
//
//   - `handOff`: the timers module's dispatcher port `simReply` (ScheduleDispatch, `advance_clock`,
//     "Disparar ahora"): a due `TIMER#SIM_REPLY#` as a `SimReplyHandoff`, invoked asynchronously
//     (`Event`): the caller never waits for SES;
//   - `sendNow`: the `QaDriver`'s `supplier.sendNow` (QA worlds only), invoked synchronously
//     (`RequestResponse`) so the step learns whether the email left; `mail.outcome` waits on the mail id.
//
// Both payloads are validated here with the receiver's own schemas before they leave.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { STAGE_REGION } from "../public-web/presign";
import { SimReplyHandoff } from "../timers/events";
import { SendNowInvocation, type SimReplyResult } from "./contract";

/** `Resource.SimMail` (infra/messaging-email.ts). */
export const SIM_MAIL_LINK = "SimMail";

export interface SimMailInvoker {
  handOff(handoff: SimReplyHandoff): Promise<void>;
  sendNow(input: Omit<SendNowInvocation, "action" | "mode">): Promise<SimReplyResult>;
}

// A send with up to three PDFs runs a few seconds; accepting an asynchronous event, milliseconds.
const SYNC_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 30_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };
const ASYNC_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 2_000, connectionTimeoutMs: 1_000, maxAttempts: 2 };
const RETRYABLE = new Set(["TooManyRequestsException", "ServiceException", "EC2ThrottledException", "TimeoutError"]);
const FunctionLink = z.object({ name: z.string().min(1) });

const SimReplyResultSchema = z.union([
  z.object({ status: z.literal("SENT"), mailId: z.string(), providerMessageId: z.string() }).strict(),
  z.object({ status: z.literal("SKIPPED"), reason: z.string() }).strict(),
  z.object({ status: z.literal("REFUSED"), code: z.enum(["INVALID", "RECIPIENT_NOT_ALLOWED", "FORBIDDEN", "NOT_FOUND"]), reason: z.string() }).strict(),
]);

export class SimMailInvokeError extends Error {
  override readonly name = "SimMailInvokeError";
}

export interface SimMailInvokerOptions {
  readonly syncClient?: Pick<LambdaClient, "send">;
  readonly asyncClient?: Pick<LambdaClient, "send">;
  readonly functionName?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function lambdaSimMailInvoker(options: SimMailInvokerOptions = {}): SimMailInvoker {
  let syncClient = options.syncClient;
  let asyncClient = options.asyncClient;
  const functionName = options.functionName ?? (() => readLinked(SIM_MAIL_LINK, FunctionLink).name);
  const retry = <T>(run: () => Promise<T>) =>
    withRetry(run, { attempts: 3, baseDelayMs: 50, ...(options.sleep ? { sleep: options.sleep } : {}), shouldRetry: (error) => RETRYABLE.has(error instanceof Error ? error.name : "") });
  const encode = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload));

  return {
    async handOff(handoff) {
      const payload = SimReplyHandoff.parse(handoff);
      const client = (asyncClient ??= new LambdaClient({ region: STAGE_REGION, ...awsClientConfig(ASYNC_TIMEOUTS) }));
      await retry(() => client.send(new InvokeCommand({ FunctionName: functionName(), InvocationType: "Event", Payload: encode(payload) })));
    },

    async sendNow(input) {
      const payload = SendNowInvocation.parse({ action: "sim_reply", mode: "SEND_NOW", ...input });
      const client = (syncClient ??= new LambdaClient({ region: STAGE_REGION, ...awsClientConfig(SYNC_TIMEOUTS) }));
      // Not retried: a send that timed out may have gone out; the step's mail id tells.
      const response = await client.send(new InvokeCommand({ FunctionName: functionName(), InvocationType: "RequestResponse", Payload: encode(payload) }));
      if (response.FunctionError !== undefined) throw new SimMailInvokeError(`SimMail failed: ${response.FunctionError}`);
      const body: unknown = response.Payload === undefined ? undefined : JSON.parse(new TextDecoder().decode(response.Payload));
      const result = SimReplyResultSchema.safeParse(body);
      if (!result.success) throw new SimMailInvokeError("SimMail answered with an unexpected shape");
      return result.data;
    },
  };
}
