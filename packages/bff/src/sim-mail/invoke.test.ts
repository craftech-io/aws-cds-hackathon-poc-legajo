import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { SimMailInvokeError, lambdaSimMailInvoker } from "./invoke";

const lambda = mockClient(LambdaClient);
const client = new LambdaClient({ region: "us-east-1" });
const invoker = () => lambdaSimMailInvoker({ syncClient: client, asyncClient: client, functionName: () => "sim-mail-fn", sleep: async () => undefined });
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)) as never;
const sent = (index = 0) => {
  const input = lambda.commandCalls(InvokeCommand)[index]?.args[0].input;
  return { type: input?.InvocationType, name: input?.FunctionName, payload: JSON.parse(new TextDecoder().decode(input?.Payload as Uint8Array | undefined)) as Record<string, unknown> };
};

const handoff = { clockId: "qa-812-1-sc02", operationId: "op-7042", timerKey: "TIMER#SIM_REPLY#sr-1", dueAtSim: "2026-10-15T22:20:00.000Z", version: 1, firmId: "firm-qa", firedBy: "CLOCK" as const, eventAtSim: "2026-10-15T22:20:00.000Z" };
const sendNowInput = { clockId: "qa-812-1-sc02", operationId: "op-7042", docTypes: ["PACKING_LIST" as const], version: 2, mailId: "qa00112233445566" };

beforeEach(() => lambda.reset());

describe("[FL-088] how the stage reaches SimMail", () => {
  it("[FL-088] a due SIM_REPLY is handed off asynchronously with the timers module's SimReplyHandoff, retried on throttling", async () => {
    lambda.on(InvokeCommand).rejectsOnce(Object.assign(new Error("slow down"), { name: "TooManyRequestsException" })).resolves({ StatusCode: 202 });
    await invoker().handOff(handoff);
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(2);
    expect(sent(1)).toEqual({ type: "Event", name: "sim-mail-fn", payload: handoff });
  });

  it("[FL-088] a hand-off that is not a SimReplyHandoff never leaves", async () => {
    await expect(invoker().handOff({ ...handoff, timerKey: "not-a-timer" })).rejects.toThrow();
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it("[FL-058] [FL-069] supplier.sendNow waits for SimMail's answer, with action sim_reply and mode SEND_NOW", async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 200, Payload: encode({ status: "SENT", mailId: "qa00112233445566", providerMessageId: "0100-sim" }) });
    expect(await invoker().sendNow(sendNowInput)).toEqual({ status: "SENT", mailId: "qa00112233445566", providerMessageId: "0100-sim" });
    expect(sent()).toEqual({ type: "RequestResponse", name: "sim-mail-fn", payload: { action: "sim_reply", mode: "SEND_NOW", ...sendNowInput } });
  });

  it("[FL-058] a refusal comes back as data; a function error or an unexpected answer is an error", async () => {
    lambda
      .on(InvokeCommand)
      .resolvesOnce({ StatusCode: 200, Payload: encode({ status: "REFUSED", code: "FORBIDDEN", reason: "SEND_NOW only in QA worlds" }) })
      .resolvesOnce({ StatusCode: 200, FunctionError: "Unhandled", Payload: encode({ errorMessage: "boom" }) })
      .resolvesOnce({ StatusCode: 200, Payload: encode({ ok: true }) });
    expect(await invoker().sendNow(sendNowInput)).toMatchObject({ status: "REFUSED", code: "FORBIDDEN" });
    await expect(invoker().sendNow(sendNowInput)).rejects.toBeInstanceOf(SimMailInvokeError);
    await expect(invoker().sendNow(sendNowInput)).rejects.toBeInstanceOf(SimMailInvokeError);
  });
});
