// Frame of every authenticated view (docs/design-brief.md §6): the navigation of the route table
// filtered by role, the header with the principal, its role and its firm, the account menu, the
// simulated-time bar that follows the world, the session notice of a guest, and the "Recorrido
// guiado" panel (open from the start for a guest, §7.1). The panel's content is views/tour, passed
// in by console-routes.tsx so the shell never imports a view. "Legajo listo · Powered by Craftech".
import { useState, type ReactNode } from "react";
import { useFirm } from "../../context/FirmContext";
import { usePrincipal } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { displayNameOf } from "../../lib/auth-claims";
import { LegajoWordmark, PoweredByCraftech } from "../brand/Brand";
import { ClockBanner } from "../ClockBanner";
import { AccountMenu } from "./AccountMenu";
import { NavMenu } from "./NavMenu";
import { QuotaNotice } from "./QuotaNotice";

function Principal() {
  const principal = usePrincipal();
  const { firmName } = useFirm();
  const name = displayNameOf(principal);
  return (
    <div className="text-right">
      {name ? <p className="font-medium text-ink">{name}</p> : null}
      <p className="text-xs text-slate">
        {copy.app.roleLabel}: {principal.role ? copy.roles[principal.role] : "—"}
        {firmName ? ` · ${copy.app.firmLabel}: ${firmName}` : null}
      </p>
    </div>
  );
}

function TourPanel({ onClose, children }: { readonly onClose: () => void; readonly children: ReactNode }) {
  return (
    <aside aria-label={copy.tour.title} className="w-full shrink-0 border-t border-mist bg-white lg:w-96 lg:border-t-0 lg:border-l">
      <header className="flex items-center justify-between border-b border-mist px-5 py-3">
        <h2 className="text-base font-semibold text-navy">{copy.tour.title}</h2>
        <button type="button" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm text-slate hover:bg-mist" onClick={onClose}>
          {copy.tour.close}
        </button>
      </header>
      <div className="px-5 py-4">{children}</div>
    </aside>
  );
}

interface AppShellProps {
  /** Content of the guided-tour panel (views/tour). */
  readonly tour?: ReactNode;
  readonly children: ReactNode;
}

export function AppShell({ tour, children }: AppShellProps) {
  const principal = usePrincipal();
  const [tourOpen, setTourOpen] = useState(principal.isGuest);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2">
        {copy.app.skipToContent}
      </a>
      <NavMenu />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-mist bg-white px-4 py-3 md:px-6">
          <div className="flex shrink-0 items-center gap-2 md:hidden">
            <LegajoWordmark tone="light" size="sm" />
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-3 text-sm">
            <Principal />
            {tour ? (
              <button
                type="button"
                aria-pressed={tourOpen}
                className="inline-flex min-h-11 items-center rounded-md border border-mist bg-white px-3 py-2 text-sm font-semibold text-navy hover:bg-paper aria-pressed:bg-cyan-soft aria-pressed:text-navy-deep"
                onClick={() => setTourOpen((open) => !open)}
              >
                {copy.tour.open}
              </button>
            ) : null}
            <AccountMenu />
          </div>
        </header>
        <ClockBanner />
        <QuotaNotice />
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <main id="content" className="min-w-0 flex-1 px-4 py-6 md:px-6">
            {children}
          </main>
          {tour && tourOpen ? <TourPanel onClose={() => setTourOpen(false)}>{tour}</TourPanel> : null}
        </div>
        <footer className="flex justify-center border-t border-mist px-6 py-3 md:hidden">
          <PoweredByCraftech tone="light" />
        </footer>
      </div>
    </div>
  );
}
