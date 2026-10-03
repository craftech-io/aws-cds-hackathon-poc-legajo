// One in-process world per test, closed after it (the AWS stubs are global to the process).
import { afterEach } from "vitest";
import { plansByOperation } from "./scripted-harness";
import type { GuardrailScript } from "./fakes/aws";
import { createFlowWorld, type FlowWorld } from "./world";

export interface WorldHolder {
  /** A world whose turns follow `plans` (per operation number and trigger; any other turn is quiet). */
  open(plans: Parameters<typeof plansByOperation>[0], options?: { readonly guardrail?: GuardrailScript; readonly realNow?: string }): Promise<FlowWorld>;
}

/** Registers the `afterEach` that closes the world the test opened. */
export function useFlowWorld(): WorldHolder {
  let world: FlowWorld | undefined;
  afterEach(() => {
    world?.close();
    world = undefined;
  });
  return {
    async open(plans, options = {}) {
      world = await createFlowWorld({ plans: plansByOperation(plans), ...(options.guardrail === undefined ? {} : { guardrail: options.guardrail }), ...(options.realNow === undefined ? {} : { realNow: options.realNow }) });
      return world;
    },
  };
}
