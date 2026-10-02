// What the shell says about the session's world, above every view (docs/design-brief.md §7.1):
//   - a guest's first sign-in creates its world (~10 s): "Preparando tu mundo de demo";
//   - another sign-in (another `origin_jti`) acted on this guest world in the last 2 hours: a fixed
//     notice, in Spanish and English, to use another guest account. It neither offers a reset
//     (that would erase the other guest's run) nor blocks anything.
import { useFirm } from "../../context/FirmContext";
import { usePrincipal } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy } from "../../copy/console";
import { minutesBetween } from "../../lib/format";

export function SessionNotice() {
  const principal = usePrincipal();
  const { account } = useFirm();
  // Re-rendered on every answer of the world clock, so "hace X min" keeps counting.
  useWorldClock();

  if (principal.isGuest && account.status === "loading" && account.previous === undefined) {
    return (
      <p role="status" className="border-b border-mist bg-info-soft px-4 py-2 text-sm text-info md:px-6">
        {copy.session.preparing}
      </p>
    );
  }
  const other = account.status === "ready" ? account.data.otherSession : undefined;
  if (!other) return null;
  const minutes = minutesBetween(Date.parse(other.lastActiveAtReal), Date.now());
  return (
    <div role="alert" className="border-b border-warning bg-warning-soft px-4 py-2.5 text-sm text-warning md:px-6">
      <p className="font-semibold">{copy.session.otherSession(minutes)}</p>
      <p lang="en" className="text-ink">
        {copy.session.otherSessionEn}
      </p>
    </div>
  );
}
