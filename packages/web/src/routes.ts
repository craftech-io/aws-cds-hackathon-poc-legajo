// Route table of the console: one entry per view of docs/design-brief.md §6, with the roles that may
// open it (docs/architecture.md §10). console-routes.tsx matches the path and renders the view of
// views/<id>/View.tsx; the AppShell builds the navigation from the same table. Approving and
// reopening are actions inside the dossier, gated by the BFF (`BROKER` or `GUEST`, recent login),
// not routes.
import type { ConsoleRole } from "@legajo/shared";
import { copy } from "./copy/console";
import { matchPath } from "./lib/match-path";

export type RouteId = keyof typeof copy.views;

export type NavGroup = keyof typeof copy.nav.groups;

export interface ConsoleRoute {
  readonly id: RouteId;
  /** Path pattern; `:name` segments become params. */
  readonly path: string;
  readonly group: NavGroup;
  /** Roles allowed in; "ALL" means every console role. */
  readonly roles: readonly ConsoleRole[] | "ALL";
  /** Navigation entry lit while this route is open (the dossier lights "Operaciones"); none = own entry. */
  readonly navParent?: RouteId;
}

export const CONSOLE_PREFIX = "/app";

export const ROUTES: readonly ConsoleRoute[] = [
  { id: "operations", path: `${CONSOLE_PREFIX}/operations`, group: "files", roles: "ALL" },
  { id: "dossier", path: `${CONSOLE_PREFIX}/operations/:operationId`, group: "files", roles: "ALL", navParent: "operations" },
  { id: "escalations", path: `${CONSOLE_PREFIX}/escalations`, group: "files", roles: "ALL" },
  { id: "registry", path: `${CONSOLE_PREFIX}/registry`, group: "parties", roles: "ALL" },
  { id: "simulator", path: `${CONSOLE_PREFIX}/simulator`, group: "demo", roles: "ALL" },
  { id: "mailbox", path: `${CONSOLE_PREFIX}/mailbox`, group: "demo", roles: "ALL" },
  { id: "clock", path: `${CONSOLE_PREFIX}/clock`, group: "demo", roles: "ALL" },
  { id: "metrics", path: `${CONSOLE_PREFIX}/metrics`, group: "control", roles: "ALL" },
  { id: "audit", path: `${CONSOLE_PREFIX}/audit`, group: "control", roles: "ALL" },
];

/** The public landing of the demo (views/landing). */
export const LANDING_PATH = "/";

// Access screens (docs/landing-spec.md D-01, views/auth): one URL per screen, all `noindex`.
export const SIGNUP_PATH = "/signup";
export const SIGNUP_VERIFY_PATH = "/signup/verify";
export const LOGIN_PATH = "/login";
export const FORGOT_PATH = "/forgot";
export const FORGOT_RESET_PATH = "/forgot/reset";
/** "Preparando tu mundo": a guest without a live world waits here (ADR-0015 §4). */
export const WELCOME_PATH = "/welcome";

export const ACCESS_PATHS: readonly string[] = [SIGNUP_PATH, SIGNUP_VERIFY_PATH, LOGIN_PATH, FORGOT_PATH, FORGOT_RESET_PATH, WELCOME_PATH];

/** Where a sign-out lands: the landing with its "Cerraste sesión" notice (FL-108). */
export const SIGNED_OUT_PARAM = "signedOut";
export const SIGNED_OUT_PATH = `${LANDING_PATH}?${SIGNED_OUT_PARAM}=1`;

/** Where a sign-in lands when nothing asked for another view. */
export const CONSOLE_HOME = `${CONSOLE_PREFIX}/operations`;

/** Routes with an entry of their own in the navigation. */
export const NAV_ROUTES: readonly ConsoleRoute[] = ROUTES.filter((route) => route.navParent === undefined);

export function routeAllows(route: ConsoleRoute, role: ConsoleRole | undefined): boolean {
  if (route.roles === "ALL") return role !== undefined;
  return role !== undefined && route.roles.includes(role);
}

export function routeTitle(route: ConsoleRoute): string {
  return copy.views[route.id].title;
}

export interface RouteMatch {
  readonly route: ConsoleRoute;
  readonly params: Readonly<Record<string, string>>;
}

/** The route of a path and its params (`/app/operations/op-4471` → dossier, `operationId`). */
export function routeOf(path: string): RouteMatch | undefined {
  for (const route of ROUTES) {
    const params = matchPath(route.path, path);
    if (params) return { route, params };
  }
  return undefined;
}

/** True while `route`'s navigation entry should read as the current page. */
export function navActive(route: ConsoleRoute, path: string): boolean {
  const current = routeOf(path)?.route;
  return current !== undefined && (current.id === route.id || current.navParent === route.id);
}

/** `/app/operations/op-4471`: the dossier of an operation. */
export function dossierPath(operationId: string): string {
  return `${CONSOLE_PREFIX}/operations/${encodeURIComponent(operationId)}`;
}
