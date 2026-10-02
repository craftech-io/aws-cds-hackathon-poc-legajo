import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Both files are read as text: infra/secrets.ts only evaluates inside the SST program ($app, sst)
// and the BFF reader imports the SST SDK, so neither can be imported from a plain vitest run.
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const declared = (source: string): string[] => [...stripComments(source).matchAll(/new sst\.Secret\("([A-Za-z0-9]+)"/g)].map((match) => match[1] ?? "");

const infraSecrets = read("./secrets.ts");
const bffSecrets = read("../packages/bff/src/lib/secrets.ts");
const architecture = read("../docs/architecture.md");
const section3 = architecture.slice(architecture.indexOf("## 3. Secretos"), architecture.indexOf("## 4."));

describe("shared secrets", () => {
  it("declares exactly the names packages/bff/src/lib/secrets.ts reads", () => {
    const names = /SECRET_NAMES = \[([^\]]+)\]/.exec(bffSecrets)?.[1]?.match(/[A-Za-z0-9]+/g) ?? [];
    expect(names.length).toBeGreaterThan(0);
    expect([...declared(infraSecrets)].sort()).toEqual([...names].sort());
  });

  it("declares the six secrets of docs/architecture.md §3, each once and never with a placeholder", () => {
    const names = declared(infraSecrets);
    const documented = [...section3.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((match) => match[1] ?? "");
    expect(documented).toHaveLength(6);
    expect([...names].sort()).toEqual([...documented].sort());
    expect([...names].sort()).toEqual(["LeadNoticeTo", "OriginVerifyKey", "SeedOverrides", "SessionTokenKey", "WabaId", "WhatsAppPhoneNumberId"]);
    expect(new Set(names).size).toBe(names.length);
    expect(stripComments(infraSecrets)).not.toMatch(/new sst\.Secret\("[A-Za-z0-9]+"\s*,/);
  });

  it("holds no lead notice address and no origin key value anywhere in infra/ (ADR-0015 §6)", () => {
    const modules = readdirSync(fileURLToPath(new URL(".", import.meta.url))).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    for (const file of modules) {
      const source = stripComments(read(`./${file}`));
      expect(source, `infra/${file}`).not.toMatch(/[A-Za-z0-9._%+-]+@craftech\.io/);
    }
    expect(section3).toContain("`disabled` hasta que el operador cargue");
  });

  it("is the only infra module that declares a secret", () => {
    const modules = readdirSync(fileURLToPath(new URL(".", import.meta.url))).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "secrets.ts",
    );
    expect(modules.length).toBeGreaterThan(10);
    for (const file of modules) expect(declared(read(`./${file}`)), `infra/${file}`).toEqual([]);
  });
});
