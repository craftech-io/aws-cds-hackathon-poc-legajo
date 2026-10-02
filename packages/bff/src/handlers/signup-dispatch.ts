// Lambda entry of `SignupDispatch` (ADR-0015 §1, §1.1; infra/leads.ts): invoked only asynchronously by
// `Bff`, without Lambda retries (a failure leaves `branch = FAILED` and the visitor may resend). The
// event is validated with zod before anything runs; the work is signup/dispatch.ts.
import { createLogger, newCorrelationId } from "../lib/log";
import { defaultAccessDeps } from "../signup/deps";
import { type DispatchOutcome, runDispatch } from "../signup/dispatch";

export const handler = async (raw: unknown): Promise<DispatchOutcome> => {
  const log = createLogger({ correlationId: newCorrelationId(), bindings: { service: "signup-dispatch" } });
  return runDispatch(defaultAccessDeps(), raw, log);
};
