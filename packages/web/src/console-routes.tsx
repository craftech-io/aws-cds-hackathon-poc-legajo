// The authenticated console: the view of the route inside the shell, with the no-access, not-found
// and forbidden screens, the firm and world-clock providers every view reads, and the security
// prompts. Loaded lazily by app.tsx, so the landing and the access screens do not download the views;
// each view (views/<id>/View.tsx) is its own chunk too, and so is the guided-tour panel. A guest never
// gets here without a firm (app.tsx sends it to `/welcome`); staff without one see "no access".
import { type ComponentType, type LazyExoticComponent, Suspense, lazy } from "react";
import { FullScreenMessage } from "./components/FullScreenMessage";
import { LoadingBlock } from "./components/RemoteBlock";
import { AppShell } from "./components/layout/AppShell";
import { FirmProvider } from "./context/FirmContext";
import { usePrincipal, useSession } from "./context/SessionContext";
import { WorldClockProvider } from "./context/WorldClockContext";
import { copy } from "./copy/console";
import { Link, Redirect, useRouter } from "./lib/router";
import { CONSOLE_HOME, CONSOLE_PREFIX, type RouteId, routeAllows, routeOf } from "./routes";
import { useNoIndex } from "./views/auth/AuthLang";
import { SecurityPrompts } from "./views/auth/SecurityPrompts";

const VIEWS: Readonly<Record<RouteId, LazyExoticComponent<ComponentType>>> = {
  operations: lazy(() => import("./views/operations/View")),
  dossier: lazy(() => import("./views/dossier/View")),
  escalations: lazy(() => import("./views/escalations/View")),
  registry: lazy(() => import("./views/registry/View")),
  simulator: lazy(() => import("./views/simulator/View")),
  mailbox: lazy(() => import("./views/mailbox/View")),
  clock: lazy(() => import("./views/clock/View")),
  metrics: lazy(() => import("./views/metrics/View")),
  audit: lazy(() => import("./views/audit/View")),
};

const TourView = lazy(() => import("./views/tour/View"));

function BackHome() {
  return (
    <Link to={CONSOLE_HOME} className="text-sm font-semibold text-cyan-deep underline">
      {copy.errors.backHome}
    </Link>
  );
}

function NotFound() {
  return (
    <FullScreenMessage title={copy.errors.notFoundTitle} lead={copy.errors.notFoundLead}>
      <BackHome />
    </FullScreenMessage>
  );
}

function Forbidden() {
  return (
    <FullScreenMessage title={copy.errors.forbiddenTitle} lead={copy.errors.forbiddenLead}>
      <BackHome />
    </FullScreenMessage>
  );
}

function NoAccess({ onSignOut }: { readonly onSignOut: () => void }) {
  return (
    <FullScreenMessage title={copy.login.noAccessTitle} lead={copy.login.noAccessLead}>
      <button type="button" className="text-sm font-semibold text-cyan-deep underline" onClick={onSignOut}>
        {copy.app.signOut}
      </button>
    </FullScreenMessage>
  );
}

export default function ConsoleRoutes() {
  // The console is never indexed (robots.txt disallows /app/ as well; ADR-0016 §1).
  useNoIndex();
  const { path } = useRouter();
  const { signOut } = useSession();
  const principal = usePrincipal();
  if (!principal.firmId) return <NoAccess onSignOut={signOut} />;
  if (path === CONSOLE_PREFIX || path === `${CONSOLE_PREFIX}/`) return <Redirect to={CONSOLE_HOME} />;

  const match = routeOf(path);
  if (!match) return <NotFound />;
  if (!routeAllows(match.route, principal.role)) return <Forbidden />;
  const View = VIEWS[match.route.id];

  return (
    <FirmProvider firmId={principal.firmId}>
      <WorldClockProvider>
        <AppShell
          tour={
            <Suspense fallback={<LoadingBlock />}>
              <TourView />
            </Suspense>
          }
        >
          <Suspense fallback={<LoadingBlock />}>
            <View />
          </Suspense>
        </AppShell>
        <SecurityPrompts />
      </WorldClockProvider>
    </FirmProvider>
  );
}
