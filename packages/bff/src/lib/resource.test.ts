import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// SST's `Resource` is a Proxy that throws for anything not linked to the function; the mock does too.
const linked: Record<string, unknown> = {
  App: { name: "aws-cds-hackathon-poc-legajo", stage: "poc" },
  Operations: { name: "aws-cds-hackathon-poc-legajo-poc-OperationsTable-abc" },
  ChannelModes: { email: "live", whatsapp: "simulated" },
  Broken: { name: "" },
};

vi.mock("sst", () => ({
  Resource: new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "string" && property in linked) return linked[property];
        throw new Error(`"${String(property)}" is not linked`);
      },
    },
  ),
}));

const { bucketName, channelMode, channelModes, currentStage, readLinked, resetResourceCache, tableName } = await import("./resource");

describe("lib/resource", () => {
  afterEach(() => {
    resetResourceCache();
    vi.unstubAllEnvs();
  });

  it("reads physical names of linked tables and the channel modes through zod", () => {
    expect(tableName("Operations")).toBe("aws-cds-hackathon-poc-legajo-poc-OperationsTable-abc");
    expect(channelModes()).toEqual({ email: "live", whatsapp: "simulated" });
    expect(channelMode("whatsapp")).toBe("simulated");
  });

  it("caches a linked value until the cache is reset", () => {
    expect(readLinked("Operations", z.object({ name: z.string() })).name).toContain("Operations");
    linked.Operations = { name: "changed" };
    expect(tableName("Operations")).toContain("OperationsTable");
    resetResourceCache();
    expect(tableName("Operations")).toBe("changed");
  });

  it("reads Runtime through its name-only link when the function may not hold the table whole", () => {
    expect(() => tableName("Runtime")).toThrow(expect.objectContaining({ code: "UNAVAILABLE", table: "Runtime" }));
    resetResourceCache();
    linked.RuntimeKeys = { name: "aws-cds-hackathon-poc-legajo-poc-RuntimeTable-abc" };
    expect(tableName("Runtime")).toBe("aws-cds-hackathon-poc-legajo-poc-RuntimeTable-abc");
    resetResourceCache();
    // A function that links the table whole keeps reading its own link.
    linked.Runtime = { name: "whole-runtime" };
    expect(tableName("Runtime")).toBe("whole-runtime");
    delete linked.Runtime;
    delete linked.RuntimeKeys;
  });

  it("fails as UNAVAILABLE when a resource is not linked or has an unexpected shape", () => {
    expect(() => bucketName("Documents")).toThrow(expect.objectContaining({ code: "UNAVAILABLE", table: "Documents" }));
    expect(() => readLinked("Broken", z.object({ name: z.string().min(1) }))).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
  });

  it("reads the stage from the stage flag, else from the app", () => {
    expect(currentStage()).toBe(process.env.STAGE ?? "poc");
    vi.stubEnv("STAGE", "poc");
    expect(currentStage()).toBe("poc");
  });
});
