import { describe, expect, it } from "vitest";
import { CONSOLE_HOME, NAV_ROUTES, ROUTES, dossierPath, navActive, routeAllows, routeOf } from "../routes";

function route(id: string) {
  const found = ROUTES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no route ${id}`);
  return found;
}

describe("console routes (docs/design-brief.md §6)", () => {
  it("has one route per view of the console, all under /app", () => {
    expect(ROUTES.map((candidate) => candidate.path)).toEqual([
      "/app/operations",
      "/app/operations/:operationId",
      "/app/escalations",
      "/app/registry",
      "/app/simulator",
      "/app/mailbox",
      "/app/clock",
      "/app/metrics",
      "/app/audit",
    ]);
    expect(routeOf(CONSOLE_HOME)?.route.id).toBe("operations");
  });

  it("tells the list of operations from the dossier of one and reads its id", () => {
    expect(routeOf("/app/operations")?.route.id).toBe("operations");
    expect(routeOf("/app/operations/")?.route.id).toBe("operations");
    expect(routeOf(dossierPath("op-4471"))).toEqual({ route: route("dossier"), params: { operationId: "op-4471" } });
    expect(routeOf("/app/operations/op-4471/extra")).toBeUndefined();
    expect(routeOf("/app/nowhere")).toBeUndefined();
  });

  it("lights the operations entry for a dossier and keeps the dossier out of the navigation", () => {
    expect(NAV_ROUTES.map((candidate) => candidate.id)).not.toContain("dossier");
    expect(navActive(route("operations"), "/app/operations/op-4471")).toBe(true);
    expect(navActive(route("audit"), "/app/operations/op-4471")).toBe(false);
  });

  it("opens every view to the three console roles and none without a role", () => {
    for (const candidate of ROUTES) {
      for (const role of ["BROKER", "ANALYST", "GUEST"] as const) expect(routeAllows(candidate, role)).toBe(true);
      expect(routeAllows(candidate, undefined)).toBe(false);
    }
  });
});
