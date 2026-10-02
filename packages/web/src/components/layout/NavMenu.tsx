// Navigation of the console, built from the route table and filtered by role: a sidebar from the
// `md` breakpoint up, a scrolling strip above the content on a phone. One <nav> for both, so the
// page has a single navigation landmark.
import { usePrincipal } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { Link, useRouter } from "../../lib/router";
import { NAV_ROUTES, navActive, routeAllows, routeTitle, type ConsoleRoute, type NavGroup } from "../../routes";
import { LegajoWordmark, PoweredByCraftech } from "../brand/Brand";

const GROUP_ORDER: readonly NavGroup[] = ["files", "parties", "demo", "control"];

function NavSection({ group, routes, path }: { readonly group: NavGroup; readonly routes: readonly ConsoleRoute[]; readonly path: string }) {
  if (routes.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 md:block">
      <p className="hidden px-3 text-xs font-semibold uppercase tracking-widest text-mist md:block">{copy.nav.groups[group]}</p>
      <ul className="flex gap-1 md:mt-2 md:block md:space-y-0.5">
        {routes.map((route) => {
          const active = navActive(route, path);
          return (
            <li key={route.id}>
              <Link
                to={route.path}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active ? "bg-navy-soft text-white" : "text-mist hover:bg-navy-soft/60 hover:text-white"
                }`}
              >
                {routeTitle(route)}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function NavMenu() {
  const { path } = useRouter();
  const principal = usePrincipal();
  const visible = NAV_ROUTES.filter((route) => routeAllows(route, principal.role));
  return (
    <nav aria-label={copy.app.navigation} className="flex shrink-0 flex-col bg-navy px-3 py-3 md:w-60 md:py-5">
      <div className="hidden space-y-2 px-3 md:block">
        <p>
          <LegajoWordmark tone="dark" size="lg" />
        </p>
        <p className="text-xs text-cyan">{copy.app.tagline}</p>
      </div>
      <div className="flex gap-4 overflow-x-auto md:mt-8 md:flex-1 md:flex-col md:gap-6 md:overflow-visible">
        {GROUP_ORDER.map((group) => (
          <NavSection key={group} group={group} routes={visible.filter((route) => route.group === group)} path={path} />
        ))}
      </div>
      <div className="mt-8 hidden space-y-3 border-t border-navy-soft px-3 pt-4 md:block">
        <p className="text-xs text-mist">{copy.app.syntheticData}</p>
        <PoweredByCraftech tone="dark" />
      </div>
    </nav>
  );
}
