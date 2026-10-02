// A usage quota of the guest world, above every view (ADR-0015 §4, docs/landing-spec.md §8.5, FL-111):
// "Llegaste al límite de esta demo por hoy (…); se renueva a las HH:MM", with the local time the BFF's
// `resetsAtReal` falls on. It is not a state of the world: the console stays open, the refused action
// had no effect, and the notice goes away when the person dismisses it.
import { useSession } from "../../context/SessionContext";
import { useAuthCopy } from "../../views/auth/AuthLang";
import { quotaMessage } from "../../views/auth/quota";

export function QuotaNotice() {
  const { quota, dismissQuota } = useSession();
  const copy = useAuthCopy();
  if (!quota) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-warning bg-warning-soft px-4 py-2.5 text-sm text-warning md:px-6">
      <p className="font-semibold">{quotaMessage(copy, quota)}</p>
      <button type="button" onClick={dismissQuota} className="min-h-11 rounded-md px-3 font-semibold text-ink hover:bg-white/60">
        {copy.quota.dismiss}
      </button>
    </div>
  );
}
