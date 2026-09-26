// A router test may carry a flow's tag only if the console procedures that drive the flow exist
// (docs/test-plan.md §2 "Etiquetas", docs/tool-catalog.md): otherwise `flows:check` would count a
// read of connector-seeded state as proof of a mutation that is not there.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appRouter } from "./index";

/** Flow → the router test that cites it and the procedures that flow runs. */
const MUTATION_FLOWS: Readonly<Record<string, { readonly file: string; readonly procedures: readonly string[] }>> = {
  "FL-001": { file: "registry.test.ts", procedures: ["registry.importers.upsert", "registry.consent.record"] },
  "FL-003": { file: "registry.test.ts", procedures: ["registry.authorization.set"] },
  "FL-004": { file: "registry.test.ts", procedures: ["registry.suppliers.upsert", "registry.contacts.upsert"] },
  "FL-005": { file: "operations.test.ts", procedures: ["operations.create"] },
};

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
}

describe("flow tags of the router tests", () => {
  const procedures = new Set(Object.keys(appRouter._def.procedures));

  for (const [flowId, { file, procedures: needed }] of Object.entries(MUTATION_FLOWS)) {
    it(`tags ${flowId} in ${file} only once ${needed.join(", ")} exist, and otherwise declares it pending`, () => {
      const text = source(file);
      const missing = needed.filter((name) => !procedures.has(name));
      if (text.includes(`[${flowId}]`)) expect(missing).toEqual([]);
      else expect(text).toContain(`[${flowId}:pending]`);
    });
  }
});
