// Flow ids of docs/flows-catalog.md (`FL-001` … `FL-132`), their areas, the test levels of the
// traceability matrix (docs/test-plan.md §2) and the scenario step references it cites. Tests tag
// every `describe`/`it` that proves a flow with `[FL-xxx]`; scenario steps declare `flows: [...]`.
import { z } from "zod";

export const FlowId = z.string().regex(/^FL-\d{3}$/, "expected FL-000");
export type FlowId = z.infer<typeof FlowId>;

/** Areas of the catalog ("Áreas" line of docs/flows-catalog.md), by letter. */
export const FLOW_AREAS = {
  A: "Onboarding and registry",
  B: "First request and the importer's WhatsApp",
  C: "Supplier by email",
  D: "Observations",
  E: "Questions and limits",
  F: "Contact policy",
  G: "ETA and clock",
  H: "Escalation and handoff",
  I: "Approval and dispatch",
  J: "Console and public surfaces",
  K: "Live channel and robustness",
  L: "Public signup, guest account and leads",
  M: "Commercial landing and neutral surfaces",
} as const;

export const FlowArea = z.enum(Object.keys(FLOW_AREAS) as [keyof typeof FLOW_AREAS, ...Array<keyof typeof FLOW_AREAS>]);
export type FlowArea = z.infer<typeof FlowArea>;

/** Test levels of the matrix: unit, local flow, console UI, scenario runner in `poc`, CI smoke. */
export const FlowLevel = z.enum(["U", "LF", "UI", "SR", "SMK"]);
export type FlowLevel = z.infer<typeof FlowLevel>;

/** `[FL-007]`, the tag a test name carries for `npm run flows:check`. */
export function flowTag(id: string): string {
  return `[${FlowId.parse(id)}]`;
}

/** Flow ids tagged in a test name, in order of appearance, without repeats. */
export function flowTagsIn(text: string): FlowId[] {
  return [...new Set([...text.matchAll(/\[(FL-\d{3})\]/g)].map((match) => match[1] ?? ""))];
}

export const ScenarioId = z.string().regex(/^SC-\d{2}$/, "expected SC-00");
export type ScenarioId = z.infer<typeof ScenarioId>;

/** A step as the matrix cites it: `SC-01/2`, a range `SC-07/1..3`, or a smoke step `SMK/3`. */
export const ScenarioStepRef = z.string().regex(/^(?:SC-\d{2}|SMK)\/\d+(?:\.\.\d+)?$/, "expected SC-00/1, SC-00/1..3 or SMK/1");
export type ScenarioStepRef = z.infer<typeof ScenarioStepRef>;

/** `SC-07/1..3` → `SC-07/1`, `SC-07/2`, `SC-07/3`; a single step stays as it is. */
export function expandStepRef(ref: string): string[] {
  const [scenario = "", steps = ""] = ScenarioStepRef.parse(ref).split("/");
  const [from = 0, to = from] = steps.split("..").map(Number);
  if (to < from) throw new RangeError(`empty step range ${ref}`);
  return Array.from({ length: to - from + 1 }, (_, offset) => `${scenario}/${from + offset}`);
}
