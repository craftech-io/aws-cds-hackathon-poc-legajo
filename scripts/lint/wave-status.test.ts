import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type RepoView, type WaveStatus, blockers, deployed, diskRepo, markersIn, parseStatus, violations } from "./wave-status";
import { PLAN_FILE, parsePlan } from "./wp-ownership";

const EMPTY_SST_ENV = 'declare module "sst" {\n  export interface Resource {}\n}\nexport {}\n';
const DEPLOYED_SST_ENV = 'declare module "sst" {\n  export interface Resource {\n    "Operations": { name: string }\n  }\n}\nexport {}\n';

const plan = (states: Record<number, string>) => `
## 2. Paquetes de trabajo

### Ola 2 · Datos

**WP-27 · Clock** — typescript-dev · —
Objetivo: x. Archivos: \`packages/bff/src/clock/**\`, \`infra/bff.ts\`. Aceptación: ok.

### Ola 5 · QA

**WP-37 · QaDriver** — qa · WP-27
Objetivo: y. Archivos: \`packages/bff/src/handlers/qa-driver.ts\`, \`tests/flows/**\`, \`packages/web/e2e/clock.spec.ts\`. Aceptación: ok.

## 3. Dependencias

## 5. Estado de las olas

| Ola | Estado | Qué falta |
|---|---|---|
${Object.entries(states)
  .map(([wave, state]) => `| Ola ${wave} | \`${state}\` | x |`)
  .join("\n")}
`;

function memoryRepo(files: Record<string, string>): RepoView {
  const paths = Object.keys(files);
  return {
    exists: (path) => paths.some((file) => file === path || file.startsWith(`${path}/`)),
    filesUnder: (dir) => paths.filter((file) => file.startsWith(`${dir}/`)),
    read: (path) => files[path] ?? "",
  };
}

/** The repository the review found: no wave 2 code, the WP-02 stub, an unwired default, todos and fixmes, never deployed. */
const UNBUILT = {
  "sst-env.d.ts": EMPTY_SST_ENV,
  "infra/bff.ts": "// Stub created by WP-02 (docs/build-plan.md): Bff, PublicWeb, QaDriver …\nexport {};\n",
  "packages/bff/src/handlers/qa-driver.ts": "export function createDefaultQaDriver(ports: QaPorts = unwiredPorts()) {}\n",
  "tests/flows/supplier.flow.test.ts": 'it.todo("[FL-020:pending] a");\nit.todo("[FL-021:pending] b");\n',
  "packages/web/e2e/clock.spec.ts": 'test.fixme("advance", async () => {});\n',
};

/** The same repository once waves 2 and 5 are built, wired and deployed. */
const BUILT = {
  "sst-env.d.ts": DEPLOYED_SST_ENV,
  "infra/bff.ts": 'export const qaDriver = new sst.aws.Function("QaDriver", {});\n',
  "packages/bff/src/clock/clock.ts": "export const clock = 1;\n",
  "packages/bff/src/handlers/qa-driver.ts": "export function createDefaultQaDriver(ports: QaPorts = realPorts()) {}\n",
  "tests/flows/supplier.flow.test.ts": 'it("[FL-020] a", () => {});\n',
  "tests/flows/support/world.ts": "export const world = 1;\n",
  "packages/web/e2e/clock.spec.ts": 'test("advance", async () => {});\n',
};

describe("parseStatus", () => {
  it("reads one state per wave row of §5", () => {
    expect(parseStatus(plan({ 2: "no iniciada", 5: "no aceptada" }))).toEqual([
      { wave: 2, state: "no iniciada" },
      { wave: 5, state: "no aceptada" },
    ]);
  });
});

describe("deployed", () => {
  it("is false while sst-env.d.ts declares an empty Resource and true once a deploy links something", () => {
    expect(deployed(EMPTY_SST_ENV)).toBe(false);
    expect(deployed(DEPLOYED_SST_ENV)).toBe(true);
  });
});

describe("markersIn", () => {
  it("counts todos, fixmes, WP-02 stubs and unwired defaults, ignoring comments and test fixtures", () => {
    expect(markersIn("a.test.ts", 'it.todo("x");\ntest.fixme("y", f);\n// it.todo("only named")\n')).toEqual(["1 × it.todo", "1 × test.fixme"]);
    expect(markersIn("infra/bff.ts", "// Stub created by WP-02\n")).toEqual(["1 × WP-02 stub"]);
    expect(markersIn("h.ts", "function f(p = unwiredPorts()) {}\nconst r = { runner: unwiredBatchRunner() };\nx ?? unwiredTargets();\n")).toEqual(["3 × unwired default"]);
    expect(markersIn("h.test.ts", "const d = createDriver({ ports: unwiredPorts() });\n")).toEqual([]);
    expect(markersIn("ports.ts", "export function unwiredPorts(): QaPorts {}\n")).toEqual([]);
  });
});

describe("violations", () => {
  it("rejects wave 5 declared aceptada on top of an unbuilt, undeployed wave 2 (B5)", () => {
    const markdown = plan({ 2: "no iniciada", 5: "aceptada" });
    const errors = violations(parsePlan(markdown), markdown, memoryRepo(UNBUILT));
    expect(errors).toHaveLength(1);
    const reasons = blockers(parsePlan(markdown), [{ wave: 2, state: "no iniciada" }, { wave: 5, state: "aceptada" }], memoryRepo(UNBUILT)).get(5);
    expect(reasons).toEqual([
      "ola 2 no aceptada",
      "WP-37: packages/bff/src/handlers/qa-driver.ts: 1 × unwired default",
      "WP-37: tests/flows/supplier.flow.test.ts: 2 × it.todo",
      "WP-37: packages/web/e2e/clock.spec.ts: 1 × test.fixme",
      "sin deploy por CI (sst-env.d.ts sin recursos)",
    ]);
    expect(blockers(parsePlan(markdown), [], memoryRepo(UNBUILT)).get(2)).toEqual([
      "WP-27: packages/bff/src/clock/** no existe",
      "WP-27: infra/bff.ts: 1 × WP-02 stub",
      "sin deploy por CI (sst-env.d.ts sin recursos)",
    ]);
  });

  it("accepts the honest status of that repository", () => {
    const markdown = plan({ 2: "no iniciada", 5: "no aceptada" });
    expect(violations(parsePlan(markdown), markdown, memoryRepo(UNBUILT))).toEqual([]);
  });

  it("still rejects wave 5 aceptada when its own work is done but wave 2 is not accepted", () => {
    const markdown = plan({ 2: "no aceptada", 5: "aceptada" });
    expect(violations(parsePlan(markdown), markdown, memoryRepo(BUILT))).toEqual(["ola 5 declarada aceptada con 1 bloqueo(s): ola 2 no aceptada"]);
  });

  it("allows aceptada once the earlier waves are accepted, every file exists, nothing is pending and poc was deployed", () => {
    const markdown = plan({ 2: "aceptada", 5: "aceptada" });
    expect(violations(parsePlan(markdown), markdown, memoryRepo(BUILT))).toEqual([]);
  });

  it("requires exactly one known state per wave", () => {
    const markdown = plan({ 2: "hecha" });
    expect(violations(parsePlan(markdown), markdown, memoryRepo(BUILT))).toEqual([
      'ola 2: estado desconocido "hecha"',
      "ola 5: 0 fila(s) en ## 5. Estado de las olas, se espera 1",
    ]);
  });
});

describe("waves in stages", () => {
  const staged = (rows: string) => `
## 2. Paquetes de trabajo

### Ola 3 · Etapa A1 · Guard

**WP-47 · Guard** — devops · —
Objetivo: x. Archivos: \`scripts/lint/neutral-surfaces.ts\`, \`scripts/ci/**\`. Aceptación: ok.

### Ola 3 · Etapa B · Logic

**WP-25 · Outbound** — typescript-dev · WP-47
Objetivo: y. Archivos: \`packages/bff/src/outbound/**\`. Aceptación: ok.

## 3. Dependencias

## 5. Estado de las olas

| Ola | Estado | Qué falta |
|---|---|---|
${rows}
`;
  const stagedRepo = memoryRepo({ "sst-env.d.ts": DEPLOYED_SST_ENV, "scripts/lint/neutral-surfaces.ts": "it.todo('x');\n", "scripts/ci/order.test.ts": "it('y', () => {});\n" });

  it("adds the blockers of every stage of a wave instead of keeping only the last one", () => {
    const markdown = staged("| Ola 3 | `aceptada` | x |");
    const reasons = blockers(parsePlan(markdown), [{ wave: 3, state: "aceptada" }], stagedRepo).get(3);
    expect(reasons).toEqual(["WP-47: scripts/lint/neutral-surfaces.ts: 1 × it.todo", "WP-25: packages/bff/src/outbound/** no existe"]);
    expect(violations(parsePlan(markdown), markdown, stagedRepo)).toEqual([
      "ola 3 declarada aceptada con 2 bloqueo(s): WP-47: scripts/lint/neutral-surfaces.ts: 1 × it.todo; WP-25: packages/bff/src/outbound/** no existe",
    ]);
  });

  it("expects one row per wave, not one per stage", () => {
    const markdown = staged("| Ola 3 | `no iniciada` | x |");
    expect(violations(parsePlan(markdown), markdown, stagedRepo)).toEqual([]);
    expect(violations(parsePlan(staged("")), staged(""), stagedRepo)).toEqual(["ola 3: 0 fila(s) en ## 5. Estado de las olas, se espera 1"]);
  });
});

describe("docs/build-plan.md", () => {
  const root = resolve(import.meta.dirname, "../..");
  const markdown = readFileSync(resolve(root, PLAN_FILE), "utf8");
  const waves = parsePlan(markdown);
  const repo = diskRepo(root);

  it("declares a state for every wave that the repository supports", () => {
    expect(violations(waves, markdown, repo)).toEqual([]);
  });

  it("keeps wave 5 not accepted while it still has blockers (B5)", () => {
    const status = parseStatus(markdown) as WaveStatus[];
    const reasons = blockers(waves, status, repo).get(5) ?? [];
    const state = status.find((row) => row.wave === 5)?.state;
    expect(reasons.length === 0 || state !== "aceptada").toBe(true);
  });
});
