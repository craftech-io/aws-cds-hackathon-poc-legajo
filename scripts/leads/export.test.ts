import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markMailStatus } from "../../packages/bff/src/channels/email/mail-status";
import { createLogger } from "../../packages/bff/src/lib/log";
import { REPO_ROOT, insideRepo } from "./common";
import { EXPORT_COLUMNS, csvCell, runExport } from "./export";
import { NOW, leadsWorld } from "./testing";

const dirs: string[] = [];
const outFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "legajo-leads-"));
  dirs.push(dir);
  return join(dir, "leads.csv");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("[FL-116] npm run leads:export", () => {
  it("writes every lead outside the repository with mode 0600 and prints only the count", async () => {
    const world = leadsWorld();
    await world.addLead("ana@despachos-del-sur.com.ar", { company: "=HYPERLINK(\"x\")", utm: { source: "linkedin" } });
    await world.addLead("bruno@aduanas-del-plata.com.ar", { consents: { terms: { accepted: true, at: "2026-10-11T12:00:00.000Z", version: "2026-10-02", privacyVersion: "2026-10-02", lang: "en" }, contact: { accepted: false, at: "2026-10-11T12:00:00.000Z", version: "2026-10-02", lang: "en" } }, signupAt: "2026-10-11T12:00:00.000Z" });
    await world.addLead("qa-signup-812-1-a@sim.legajo.demo.craftech.io");
    const printed: string[] = [];
    const out = outFile();
    expect(await runExport(world.deps, ["--out", out], (line) => printed.push(line))).toBe(2);
    expect(printed).toEqual(["leads:export: 2 row(s) written"]);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines[0]).toBe(EXPORT_COLUMNS.map(csvCell).join(","));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain('"linkedin"');
    expect(lines.join("\n")).not.toContain("sim.legajo.demo.craftech.io");
  });

  it("--contactable keeps only accepted contact with emailStatus OK; --since filters by signupAt", async () => {
    const world = leadsWorld();
    await world.addLead("ana@despachos-del-sur.com.ar");
    await world.addLead("rebota@despachos-del-sur.com.ar");
    await world.addLead("nocontacto@despachos-del-sur.com.ar", { consents: { terms: { accepted: true, at: "2026-10-10T12:00:00.000Z", version: "2026-10-02", privacyVersion: "2026-10-02", lang: "es" }, contact: { accepted: false, at: "2026-10-10T12:00:00.000Z", version: "2026-10-02", lang: "es" } } });
    await markMailStatus({ client: world.deps.client, leadEmailKey: world.deps.leadEmailKey, log: createLogger({ level: "error" }), now: () => NOW }, { kind: "BOUNCE", recipients: ["rebota@despachos-del-sur.com.ar"] });
    const out = outFile();
    expect(await runExport(world.deps, ["--out", out, "--contactable"], () => undefined)).toBe(1);
    expect(readFileSync(out, "utf8")).toContain("ana@despachos-del-sur.com.ar");
    expect(await runExport(world.deps, ["--out", out], () => undefined)).toBe(3);
    expect(readFileSync(out, "utf8")).toContain('"BOUNCED"');
    expect(await runExport(world.deps, ["--out", out, "--since", "2026-10-11"], () => undefined)).toBe(0);
  });

  it("refuses a path inside the repository, a bad date and a missing --out", async () => {
    const world = leadsWorld();
    expect(insideRepo(join(REPO_ROOT, "leads.csv"))).toBe(true);
    expect(insideRepo(join(REPO_ROOT, "..", "leads.csv"))).toBe(false);
    await expect(runExport(world.deps, ["--out", join(REPO_ROOT, "tmp-leads.csv")])).rejects.toThrow("outside the repository");
    await expect(runExport(world.deps, ["--out", outFile(), "--since", "14/10/2026"])).rejects.toThrow(RangeError);
    await expect(runExport(world.deps, [])).rejects.toThrow("--out");
    await expect(runExport(world.deps, ["--out", outFile(), "--stage", "prod"])).rejects.toThrow(RangeError);
  });
});
