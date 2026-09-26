// Route table of the console: one entry per view of docs/design-brief.md §6, with the roles that
// may open it (docs/architecture.md §10). console-routes.tsx matches the path; the AppShell builds
// the navigation from the same table.
import type { ConsoleRole } from "@legajo/shared";
import { copy } from "./copy/console";

export type RouteId = keyof typeof copy.views;

export type NavGroup = keyof typeof copy.nav.groups;

export interface ConsoleRoute {
  readonly id: RouteId;
  readonly path: string;
  readonly group: NavGroup;
  /** Roles allowed in; "ALL" means every console role. */
  readonly roles: readonly ConsoleRole[] | "ALL";
}

export const CONSOLE_PREFIX = "/app";

export const ROUTES: readonly ConsoleRoute[] = [
  { id: "operations", path: `${CONSOLE_PREFIX}/operations`, group: "files", roles: "ALL" },
  { id: "escalations", path: `${CONSOLE_PREFIX}/escalations`, group: "files", roles: "ALL" },
  { id: "registry", path: `${CONSOLE_PREFIX}/registry`, group: "parties", roles: "ALL" },
  { id: "simulator", path: `${CONSOLE_PREFIX}/simulator`, group: "demo", roles: "ALL" },
  { id: "mailbox", path: `${CONSOLE_PREFIX}/mailbox`, group: "demo", roles: "ALL" },
  { id: "clock", path: `${CONSOLE_PREFIX}/clock`, group: "demo", roles: "ALL" },
  { id: "metrics", path: `${CONSOLE_PREFIX}/metrics`, group: "control", roles: "ALL" },
  { id: "audit", path: `${CONSOLE_PREFIX}/audit`, group: "control", roles: "ALL" },
];

export const LOGIN_PATH = "/login";

/** The public welcome page of the demo (views/landing). */
export const LANDING_PATH = "/";

/** Where a sign-in lands when nothing asked for another view. */
export const CONSOLE_HOME = `${CONSOLE_PREFIX}/operations`;

export function routeAllows(route: ConsoleRoute, role: ConsoleRole | undefined): boolean {
  if (route.roles === "ALL") return role !== undefined;
  return role !== undefined && route.roles.includes(role);
}

export function routeTitle(route: ConsoleRoute): string {
  return copy.views[route.id].title;
}
