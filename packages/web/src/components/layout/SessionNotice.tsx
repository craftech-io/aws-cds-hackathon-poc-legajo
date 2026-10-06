// What the shell says about the session above every view (docs/design-brief.md §7.1, ADR-0014 §8,
// ADR-0015 §4):
//   - a usage quota the last call ran into (QuotaNotice), with the time it resets;
//   - another sign-in (another `origin_jti`) acted on this guest world in the last 2 hours: a fixed
//     notice to use another guest account, in the console's language and, under the Spanish one, its
//     fixed English line. It neither offers a reset (that would erase the other guest's run) nor blocks
//     anything.
// A guest reaches the console only with its world ready (`/welcome` waits for it before).
import { useConsoleLang } from "../../context/ConsoleLangContext";
import { useFirm } from "../../context/FirmContext";
import { usePrincipal } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy } from "../../copy/console";
import { minutesBetween } from "../../lib/format";
import { QuotaNotice } from "./QuotaNotice";

function OtherSessionNotice() {
  const { lang } = useConsoleLang();
  const principal = usePrincipal();
  const { account } = useFirm();
  // Re-rendered on every answer of the world clock, so "hace X min" keeps counting.
  useWorldClock();
  const other = principal.isGuest && account.status === "ready" ? account.data.otherSession : undefined;
  if (!other) return null;
  const minutes = minutesBetween(Date.parse(other.lastActiveAtReal), Date.now());
  return (
    <div role="alert" className="border-b border-warning bg-warning-soft px-4 py-2.5 text-sm text-warning md:px-6">
      <p className="font-semibold">{copy.session.otherSession(minutes)}</p>
      {lang === "es" ? (
        <p lang="en" className="text-ink">
          {copy.session.otherSessionEn}
        </p>
      ) : null}
    </div>
  );
}

export function SessionNotice() {
  return (
    <>
      <QuotaNotice />
      <OtherSessionNotice />
    </>
  );
}
