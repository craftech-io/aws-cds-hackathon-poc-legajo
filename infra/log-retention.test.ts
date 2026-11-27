// Every log group this app creates keeps its logs 14 days, declared in one place
// (observability-spec.ts): the Lambdas through the $transform of sst.config.ts, the Harness runtime
// group through AGENT_LOG_RETENTION_DAYS. No module writes a retention of its own.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_LOG_RETENTION_DAYS } from "./agentcore-spec";
import { LOG_RETENTION, LOG_RETENTION_DAYS } from "./observability-spec";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

describe("[FL-138] log retention", () => {
  it("is 14 days, in SST's words and in days", () => {
    expect(LOG_RETENTION_DAYS).toBe(14);
    expect(LOG_RETENTION).toBe("2 weeks");
    expect(AGENT_LOG_RETENTION_DAYS).toBe(LOG_RETENTION_DAYS);
  });

  it("reaches every Lambda through the $transform and the runtime group through its constant", () => {
    expect(read("sst.config.ts")).toContain("args.logging ??= { retention: LOG_RETENTION };");
    expect(read("infra/agentcore.ts")).toContain("retentionInDays: AGENT_LOG_RETENTION_DAYS");
  });

  it("is written nowhere else in infra/ nor sst.config.ts", () => {
    const sources = ["sst.config.ts", ...readdirSync(resolve(ROOT, "infra")).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).map((file) => `infra/${file}`)];
    for (const source of sources) {
      const text = read(source);
      expect(text, source).not.toMatch(/retention:\s*"/);
      expect(text, source).not.toMatch(/retentionInDays:\s*\d/);
    }
  });
});
