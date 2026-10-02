// Lambda entry of `PolicyAudit` (docs/architecture.md §12): the daily schedule audits what went out
// in the last day of every `DEMO` and `GUEST` firm, listed when it runs (guest firms come and go), and
// the `QaDriver` (`policyAudit.run`) audits one world of a QA firm in full. The input is validated with
// zod; the logic is policy-audit/audit.ts.
import { z } from "zod";
import { ClockId, FirmId, QA_FIRM_IDS } from "@legajo/shared";
import { connector } from "../connector/index";
import { createLogger, newCorrelationId } from "../lib/log";
import { type PolicyAuditDeps, type PolicyAuditReport, runPolicyAudit } from "../policy-audit/audit";

/** The daily run looks back a little more than a day, so a late schedule never leaves a gap. */
export const DAILY_LOOKBACK_HOURS = 26;

export const PolicyAuditEvent = z.discriminatedUnion("kind", [
  /** Schedule input (infra/bff.ts, observability-spec.ts `POLICY_AUDIT`): the firms are listed at run time. */
  z.object({ kind: z.literal("DAILY"), lookbackHours: z.number().int().positive().max(24 * 30).default(DAILY_LOOKBACK_HOURS) }).strict(),
  /** `QaDriver` `policyAudit.run`: one world of a QA firm, every message. */
  z.object({ kind: z.literal("WORLD"), firmId: FirmId.refine((firmId) => QA_FIRM_IDS.includes(firmId), "only QA firms are audited on demand"), clockId: ClockId }).strict(),
]);
export type PolicyAuditEvent = z.input<typeof PolicyAuditEvent>;

/** The firms the daily run audits: QA firms are audited per world, on demand. */
export const DAILY_FIRM_KINDS = ["DEMO", "GUEST"] as const;

export interface PolicyAuditResult {
  readonly reports: readonly PolicyAuditReport[];
  /** Firms of a daily run whose audit could not start (logged with `policy_audit.firm_failed`). */
  readonly failedFirms: readonly string[];
  readonly violations: number;
}

export function createPolicyAuditHandler(deps: PolicyAuditDeps) {
  return async (raw: unknown): Promise<PolicyAuditResult> => {
    const event = PolicyAuditEvent.parse(raw);
    const reports: PolicyAuditReport[] = [];
    const failedFirms: string[] = [];
    if (event.kind === "WORLD") {
      reports.push(await runPolicyAudit(deps, { firmId: event.firmId, clockId: event.clockId }));
    } else {
      const sinceReal = new Date(deps.now().getTime() - event.lookbackHours * 3_600_000).toISOString();
      const firms = await deps.data.firms.listFirms(DAILY_FIRM_KINDS);
      for (const { firmId } of firms) {
        try {
          reports.push(await runPolicyAudit(deps, { firmId, sinceReal }));
        } catch (error) {
          // One firm that cannot be read never leaves the others unaudited.
          failedFirms.push(firmId);
          deps.log.error("policy_audit.firm_failed", { firmId, error: error instanceof Error ? error.name : "unknown" });
        }
      }
    }
    return { reports, failedFirms, violations: reports.reduce((sum, report) => sum + report.violations.length, 0) };
  };
}

export const handler = async (raw: unknown): Promise<PolicyAuditResult> => {
  const correlationId = newCorrelationId();
  const deps: PolicyAuditDeps = { data: connector(), now: () => new Date(), log: createLogger({ correlationId, bindings: { service: "policy-audit" } }), correlationId };
  return createPolicyAuditHandler(deps)(raw);
};
