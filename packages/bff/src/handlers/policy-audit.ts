// Lambda entry of `PolicyAudit` (docs/architecture.md §12): the daily schedule audits what went out
// in the last day of every firm it names, and the `QaDriver` (`policyAudit.run`) audits one world of
// a QA firm in full. The input is validated with zod; the logic is policy-audit/audit.ts.
import { z } from "zod";
import { ClockId, FirmId, QA_FIRM_IDS } from "@legajo/shared";
import { connector } from "../connector/index";
import { createLogger, newCorrelationId } from "../lib/log";
import { type PolicyAuditDeps, type PolicyAuditReport, runPolicyAudit } from "../policy-audit/audit";

/** The daily run looks back a little more than a day, so a late schedule never leaves a gap. */
export const DAILY_LOOKBACK_HOURS = 26;

export const PolicyAuditEvent = z.discriminatedUnion("kind", [
  /** Schedule input (infra/bff.ts): the firms to audit. */
  z.object({ kind: z.literal("DAILY"), firmIds: z.array(FirmId).min(1).max(100), lookbackHours: z.number().int().positive().max(24 * 30).default(DAILY_LOOKBACK_HOURS) }).strict(),
  /** `QaDriver` `policyAudit.run`: one world of a QA firm, every message. */
  z.object({ kind: z.literal("WORLD"), firmId: FirmId.refine((firmId) => QA_FIRM_IDS.includes(firmId), "only QA firms are audited on demand"), clockId: ClockId }).strict(),
]);
export type PolicyAuditEvent = z.input<typeof PolicyAuditEvent>;

export interface PolicyAuditResult {
  readonly reports: readonly PolicyAuditReport[];
  readonly violations: number;
}

export function createPolicyAuditHandler(deps: PolicyAuditDeps) {
  return async (raw: unknown): Promise<PolicyAuditResult> => {
    const event = PolicyAuditEvent.parse(raw);
    const reports: PolicyAuditReport[] = [];
    if (event.kind === "WORLD") {
      reports.push(await runPolicyAudit(deps, { firmId: event.firmId, clockId: event.clockId }));
    } else {
      const sinceReal = new Date(deps.now().getTime() - event.lookbackHours * 3_600_000).toISOString();
      for (const firmId of event.firmIds) reports.push(await runPolicyAudit(deps, { firmId, sinceReal }));
    }
    return { reports, violations: reports.reduce((sum, report) => sum + report.violations.length, 0) };
  };
}

export const handler = async (raw: unknown): Promise<PolicyAuditResult> => {
  const correlationId = newCorrelationId();
  const deps: PolicyAuditDeps = { data: connector(), now: () => new Date(), log: createLogger({ correlationId, bindings: { service: "policy-audit" } }), correlationId };
  return createPolicyAuditHandler(deps)(raw);
};
