// The open escalation a firm decision answers: the observation's (`OBSERVATION_ATTEMPTS`) when it is
// waived, the version's (`UNRECOGNIZED_DOCUMENT`) when it is classified or discarded. Resolving it is
// part of the decision, so the console stops showing it as pending; an escalation already resolved is
// left as it is.
import type { Escalation } from "../../domain/operations";
import type { DirectContext } from "../operations-admin/handler-kit";

export async function resolveMatching(ctx: DirectContext<unknown>, operationId: string, atSim: string, resolution: string, matches: (escalation: Escalation) => boolean): Promise<string[]> {
  const open = await ctx.connector.operations.listEscalations(operationId, { status: "OPEN" });
  const resolved: string[] = [];
  for (const escalation of open.filter(matches)) {
    await ctx.connector.operations.resolveEscalation({ operationId, escalationId: escalation.escalationId, atSim, by: ctx.actor, resolution, expectedVersion: escalation.version });
    resolved.push(escalation.escalationId);
  }
  return resolved;
}
