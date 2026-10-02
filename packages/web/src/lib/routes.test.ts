import { describe, expect, it } from "vitest";
import { ACCESS_PATHS, CONSOLE_HOME, CONSOLE_PREFIX, NAV_ROUTES, ROUTES, SIGNED_OUT_PATH, WELCOME_PATH, dossierPath, navActive, routeAllows, routeOf } from "../routes";

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

describe("[FL-101] public access routes (docs/landing-spec.md D-01)", () => {
  it("[FL-101] has one URL per access screen, outside the console", () => {
    expect(ACCESS_PATHS).toEqual(["/signup", "/signup/verify", "/login", "/forgot", "/forgot/reset", "/welcome"]);
    for (const path of ACCESS_PATHS) {
      expect(path.startsWith(CONSOLE_PREFIX)).toBe(false);
      expect(routeOf(path)).toBeUndefined();
    }
    expect(WELCOME_PATH).toBe("/welcome");
  });

  it("[FL-108] lands a sign-out on the landing with its notice", () => {
    expect(SIGNED_OUT_PATH).toBe("/?signedOut=1");
  });
});
