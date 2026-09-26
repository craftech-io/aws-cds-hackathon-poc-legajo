import { describe, expect, it } from "vitest";
import { matchPath } from "./match-path";

describe("matchPath", () => {
  it("matches static paths ignoring trailing slashes", () => {
    expect(matchPath("/", "/")).toEqual({});
    expect(matchPath("/app/operations", "/app/operations/")).toEqual({});
    expect(matchPath("/app/operations", "/")).toBeUndefined();
  });

  it("extracts and decodes params", () => {
    expect(matchPath("/app/operations/:operationId", "/app/operations/op-4471%20b")).toEqual({ operationId: "op-4471 b" });
    expect(matchPath("/app/operations/:operationId", "/app/operations")).toBeUndefined();
    expect(matchPath("/app/operations/:operationId", "/app/operations/x/y")).toBeUndefined();
  });
});
