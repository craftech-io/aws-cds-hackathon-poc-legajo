// The committed seed against the code that reads it (docs/seed-spec.md §1 and §16): every item passes
// the zod schema of its entity and sits at the key the connector uses, the mocks' rows pass the
// mocks' schemas, the world templates instantiate to valid worlds (the demo ones to exactly the table
// files), and the in-memory connector serves what the seed store loads.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryStores } from "@legajo/bff/connector/index";
import { parseSeedOverrides } from "@legajo/bff/lib/secrets";
import { DOMAIN_TABLES, DELTA_CLOCK, NORTE_CLOCK, QA_CLOCK, SEED, SEED_REAL_NOW, SEED_ROOT, START_AT_SIM } from "../lib/constants";
import { readSeed } from "../lib/files";
import { tableConformance, templateConformance } from "../validate/conformance";

const seed = readSeed();
const items = Object.values(seed.tables).flatMap((table) => table.items);
const count = (entity: string, clockId?: string) => items.filter((item) => item.entity === entity && (clockId === undefined || item.clockId === clockId)).length;

describe("seed conforms to the domain", () => {
  it("writes one file per table with the seed, the seed's clock and a count equal to its items", () => {
    for (const [table, file] of Object.entries(seed.tables)) {
      expect(file.table, table).toBe(table);
      expect(file.seed).toBe(SEED);
      expect(file.generatedAt).toBe(SEED_REAL_NOW);
      expect(file.count, table).toBe(file.items.length);
    }
    for (const item of items) expect(item, `${String(item.PK)}/${String(item.SK)}`).toMatchObject({ createdAt: SEED_REAL_NOW, updatedAt: SEED_REAL_NOW, version: 1, synthetic: true });
  });

  it("validates every item with its entity's schema and the connector's keys and GSI attributes", () => {
    expect(tableConformance(seed)).toEqual([]);
  });

  it("seeds the 30 operations of §7 with their three documents and five milestones, and no Runtime state", () => {
    expect(count("Operation", DELTA_CLOCK)).toBe(24);
    expect(count("Operation", NORTE_CLOCK)).toBe(6);
    expect(count("Document", DELTA_CLOCK) + count("Document", NORTE_CLOCK)).toBe(90);
    expect(items.filter((item) => item.entity === "Timer" && item.kind === "MILESTONE" && item.clockId !== QA_CLOCK)).toHaveLength(150);
    expect(count("Operation", QA_CLOCK)).toBe(5);
    const runtime = new Set(["Session", "Turn", "TurnResult", "Nonce", "UploadLink", "Clock", "Idempotency", "RateCounter", "TurnCap", "Counter", "OpState", "WorldState", "MailPending", "ScanPending", "Lease", "Tombstone", "Probe", "MailProbe"]);
    expect(items.filter((item) => runtime.has(item.entity))).toEqual([]);
    expect(Object.keys(seed.tables)).not.toContain("Runtime");
  });

  it("instantiates every world template into valid items, and the demo ones into the table files", async () => {
    expect(Object.keys(seed.templates).sort()).toEqual(["demo-firm-delta", "demo-firm-norte", "judge", "models", "qa-min"]);
    for (const template of Object.values(seed.templates)) expect(template.startAtSim).toBe(START_AT_SIM);
    expect(await templateConformance(seed)).toEqual([]);
  });

  it("leaves the stage's key and the world's epoch out of the templates, for the world factory to fill", () => {
    for (const [name, template] of Object.entries(seed.templates)) {
      for (const item of Object.values(template.items).flat()) {
        if (item.entity === "PlatformOperation") continue;
        for (const field of ["PK", "SK", "worldEpoch", "threadTag", "threadAddress", "phoneHash", "emailHash"]) expect(item, `${name} ${item.entity}`).not.toHaveProperty(field);
      }
    }
    expect(seed.templates.judge?.placeholders).toMatchObject({ firmId: "firm-judge-00", clockId: "JUDGE#firm-judge-00", mailboxTag: "j00" });
    expect(seed.templates.models?.operations).toHaveLength(30);
  });

  it("loads into the in-memory connector, which serves the demo world as the console reads it", async () => {
    const stores = createMemoryStores({ now: () => new Date(SEED_REAL_NOW) });
    for (const table of DOMAIN_TABLES) await stores.seed.loadItems(table, seed.tables[table].items as never);
    const operation = await stores.connector.operations.getOperation("op-4471");
    expect(operation).toMatchObject({ firmId: "firm-delta", clockId: DELTA_CLOCK, dossierStatus: "OPEN", worldEpoch: 1, invoiceNumber: "QBT-2026-0917", vessel: "Austral Aurora" });
    expect(operation.threadAddress).toMatch(/^op-4471-[0-9a-hjkmnp-tv-z]{6}@legajo\.demo\.craftech\.io$/);
    expect(await stores.connector.operations.listOperations("firm-delta", { clockId: DELTA_CLOCK })).toHaveLength(24);
    expect(await stores.connector.operations.listOperations("firm-norte", { clockId: NORTE_CLOCK })).toHaveLength(6);
  });

  it("ships an overrides example with the shape of the SeedOverrides secret and no real address", () => {
    const example = parseSeedOverrides(readFileSync(join(SEED_ROOT, "overrides.example.json"), "utf8"));
    expect(Object.keys(example).sort()).toEqual(["demoRecipients", "firmMailboxCc", "importerPhones", "operatorEmail"]);
    for (const email of [...example.demoRecipients.emails, example.operatorEmail ?? ""]) expect(email).toMatch(/@sim\.legajo\.demo\.craftech\.io$/);
    for (const phone of [...example.demoRecipients.phones, ...Object.values(example.importerPhones)]) expect(phone).toMatch(/^\+5491155500[12]\d{2}$/);
  });
});
