// The reads every turn starts with, run by the worker before the Harness (ADR-0019): the model used to
// spend its first round trip asking for them, and the Harness runs a response's tool calls one after the
// other. Each goes through the operations target in process with the turn's own token, so it passes the
// same fences as a Gateway call and leaves its `Runtime/TURN#…/RESULT#` row: what the model reads in the
// envelope grounds G2 and the outbound verification exactly as if it had called the tool itself.
//
//   every turn          get_operation (with the importer's recent operations) and get_dossier
//   importer message    also get_checklist and the importer's get_counterpart_profile: the reply needs them
//
// A read that fails is left out: the model calls it itself, as before.
import type { TurnTrigger } from "@legajo/shared";
import type { PreloadedResult } from "../agent/envelope";
import type { GatewayTargetRuntime } from "../agent-tools/common/handler";
import type { Logger } from "../lib/log";

export type TurnReads = Pick<GatewayTargetRuntime, "invoke">;

interface Read {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

const EVERY_TURN: readonly Read[] = [
  { tool: "get_operation", input: {} },
  { tool: "get_dossier", input: {} },
];

const IMPORTER_MESSAGE: readonly Read[] = [
  { tool: "get_checklist", input: {} },
  { tool: "get_counterpart_profile", input: { party: "IMPORTER" } },
];

export function readsFor(trigger: TurnTrigger): readonly Read[] {
  return trigger === "IMPORTER_MESSAGE" ? [...EVERY_TURN, ...IMPORTER_MESSAGE] : EVERY_TURN;
}

/** Runs the turn's reads together; only the answers that came back `ok` reach the envelope. */
export async function preloadReads(reads: TurnReads, sessionToken: string, trigger: TurnTrigger, log: Logger): Promise<PreloadedResult[]> {
  const planned = readsFor(trigger);
  const answers = await Promise.all(planned.map((read) => reads.invoke(read.tool, { ...read.input, sessionToken })));
  const preloaded: PreloadedResult[] = [];
  answers.forEach((answer, index) => {
    const tool = planned[index]?.tool ?? "";
    if (answer.ok) preloaded.push({ tool, output: answer });
    else log.warn("turn.preload_failed", { tool, code: answer.error.code, reason: answer.error.reason });
  });
  return preloaded;
}
