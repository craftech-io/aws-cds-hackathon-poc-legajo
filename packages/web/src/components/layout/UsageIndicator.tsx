// A guest's usage of its demo world (ADR-0015 §4, docs/landing-spec.md §8.5): `account.usage`, one line
// per kind with the window closest to its cap, and the day's budget of the public worlds when it is
// spent. Discreet: it lives in the account menu, read when the menu opens.
import { useSession } from "../../context/SessionContext";
import { useRemote } from "../../lib/use-remote";
import { useAuthCopy } from "../../views/auth/AuthLang";
import { usageLines } from "../../views/auth/quota";
import { fetchUsage } from "../../views/auth/signup-api";

export function UsageIndicator() {
  const { trpc, state } = useSession();
  const copy = useAuthCopy();
  const sub = state.status === "authenticated" ? state.principal.sub : "";
  const { state: usage } = useRemote(`account.usage:${sub}`, (signal) => fetchUsage(trpc, signal));
  if (usage.status !== "ready") return null;
  const lines = usageLines(copy, usage.data.quotas);
  return (
    <section aria-label={copy.quota.usage} className="border-t border-mist px-3 py-2 text-xs text-slate">
      <p className="font-semibold uppercase tracking-wide">{copy.quota.usage}</p>
      {usage.data.globalBudget === "EXHAUSTED" ? <p className="mt-1 text-warning">{copy.quota.globalExhausted}</p> : null}
      <ul className="mt-1 space-y-0.5">
        {lines.map((line) => (
          <li key={line.kind} className={`flex justify-between gap-3 ${line.exhausted ? "text-warning" : ""}`}>
            <span>{line.label}</span>
            <span className="tabular-nums">{copy.quota.usageLine(line.used, line.limit)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
