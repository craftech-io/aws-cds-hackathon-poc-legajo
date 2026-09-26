import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryStores } from "./index";
import { CLOCK, FIRM, REAL_NOW, memoryStores, seedDemoSlice } from "../testing";

const SEED_META = { createdAt: REAL_NOW, updatedAt: REAL_NOW, version: 1, synthetic: true };

describe("memory connector: firms and reference", () => {
  let stores: MemoryStores;

  beforeEach(async () => {
    stores = memoryStores();
    await stores.seed.loadItems("Firms", [
      { PK: "FIRM#firm-delta", SK: "META", entity: "Firm", ...SEED_META, firmId: FIRM, name: "Estudio Delta", kind: "DEMO", mailboxAddress: "estudio-delta@sim.legajo.demo.craftech.io", clockId: CLOCK, businessHours: { timezone: "America/Argentina/Buenos_Aires", from: "09:00", to: "18:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"] } },
      { PK: "FIRM#firm-delta", SK: "BROKER#brk-delta-diego", entity: "Broker", ...SEED_META, brokerId: "brk-delta-diego", firmId: FIRM, name: "Diego Ferreyra", role: "BROKER", cognitoSub: "" },
      { PK: "FIRM#firm-delta", SK: "CHECKLIST#CERTIFICATE_OF_ORIGIN#v001", entity: "Checklist", ...SEED_META, firmId: FIRM, docType: "CERTIFICATE_OF_ORIGIN", checklistVersion: 1, items: [{ itemId: "CO-02", docType: "CERTIFICATE_OF_ORIGIN", text: "Firmado y sellado por la entidad emisora", required: true }] },
      { PK: "FIRM#firm-delta", SK: "CHECKLIST#CERTIFICATE_OF_ORIGIN#v002", entity: "Checklist", ...SEED_META, firmId: FIRM, docType: "CERTIFICATE_OF_ORIGIN", checklistVersion: 2, items: [{ itemId: "CO-05", docType: "CERTIFICATE_OF_ORIGIN", text: "País de origen declarado", required: true }] },
      { PK: "FIRM#firm-delta", SK: "RESP_MATRIX#v001", entity: "ResponsibilityMatrix", ...SEED_META, firmId: FIRM, matrixVersion: 1, rules: [{ docType: "ANY", code: "LOW_CONFIDENCE", responsible: "SENDER" }] },
    ]);
  });

  it("reads the firm, the latest checklist per document type and the latest matrix", async () => {
    const { firms } = stores.connector;
    expect((await firms.getFirm(FIRM)).mailboxAddress).toBe("estudio-delta@sim.legajo.demo.craftech.io");
    expect((await firms.getChecklist(FIRM, "CERTIFICATE_OF_ORIGIN"))?.checklistVersion).toBe(2);
    expect(await firms.getChecklist(FIRM, "PACKING_LIST")).toBeUndefined();
    expect((await firms.listChecklists(FIRM)).map((checklist) => checklist.docType)).toEqual(["CERTIFICATE_OF_ORIGIN"]);
    expect((await firms.getResponsibilityMatrix(FIRM))?.fallback).toBe("BROKER");
    await expect(firms.getSettings(FIRM)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("binds a Cognito sub to a broker and finds it only inside its own firm", async () => {
    const { firms } = stores.connector;
    expect(await firms.findBrokerBySub(FIRM, "")).toBeUndefined();
    const bound = await firms.setBrokerCognitoSub(FIRM, "brk-delta-diego", "sub-123");
    expect(bound).toMatchObject({ cognitoSub: "sub-123", active: true, version: 2 });
    expect((await firms.findBrokerBySub(FIRM, "sub-123"))?.brokerId).toBe("brk-delta-diego");
    expect(await firms.findBrokerBySub("firm-norte", "sub-123")).toBeUndefined();
    expect(await firms.listBrokers(FIRM)).toHaveLength(1);
  });

  it("validates every seed item against its entity and table before writing anything", async () => {
    const bad = [
      { PK: "REF#HOLIDAY#AR", SK: "2026-10-12", entity: "Holiday", ...SEED_META, country: "AR", date: "2026-10-12", name: "Día del Respeto a la Diversidad Cultural", verified: false },
      { PK: "REF#HOLIDAY#AR", SK: "2026-11-23", entity: "Holiday", ...SEED_META, country: "AR", date: "23/11/2026", name: "Feriado", verified: false },
      { PK: "IMP#x", SK: "META", entity: "Importer", ...SEED_META },
    ];
    const problems = stores.seed.validateItems("Reference", bad);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toContain("belongs to Parties");
    await expect(stores.seed.loadItems("Reference", bad)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(stores.client.dump("Reference")).toEqual([]);
    await stores.seed.loadItems("Reference", [bad[0] as never]);
    expect(await stores.connector.reference.listHolidays("AR")).toHaveLength(1);
  });

  it("accepts what the connector itself writes and refuses a seed item at the wrong key or without its GSI attributes", async () => {
    const written = memoryStores();
    await seedDemoSlice(written);
    await written.connector.timers.createTimer({ operationId: "op-4471", clockId: CLOCK, kind: "MILESTONE", timerId: "DOCS_REQUEST", dueAtSim: "2026-10-15T10:00:00-03:00", status: "SCHEDULED" });
    const operations = written.client.dump("Operations");
    expect(stores.seed.validateItems("Operations", operations as never)).toEqual([]);
    expect(stores.seed.validateItems("Parties", written.client.dump("Parties") as never)).toEqual([]);

    const operation = operations.find((row) => row.SK === "META");
    const timer = operations.find((row) => row.entity === "Timer");
    const broken = [
      { ...operation, SK: "OPERATION" },
      { ...operation, PK: "OP#op-4472", operationId: "op-4472", firmStatusKey: "FIRM#firm-delta#APPROVED" },
      { ...timer, dueAtSim: "2026-10-15T10:00:00-03:00", clockDueKey: undefined },
    ];
    const problems = stores.seed.validateItems("Operations", broken as never);
    expect(problems).toEqual([
      "OP#op-4471/OPERATION: key should be OP#op-4471/META",
      "OP#op-4472/META: firmStatusKey should be FIRM#firm-delta#OPEN",
      expect.stringContaining("clockDueKey should be CLOCK#GLOBAL#firm-delta"),
      expect.stringContaining("dueAtSim should be the canonical UTC instant 2026-10-15T13:00:00.000Z"),
    ]);
  });

  it("reads templates and glossary entries and records a template's status", async () => {
    await stores.seed.loadItems("Reference", [
      { PK: "REF#TEMPLATE#WHATSAPP", SK: "legajo_aprobado", entity: "Template", ...SEED_META, name: "legajo_aprobado", language: "es_AR", category: "UTILITY", body: "Operación {{1}}: el estudio aprobó el legajo.", paramCount: 1, status: "LOCAL_ONLY", gloss: "Operation {{1}}: the firm approved the file." },
      { PK: "REF#DISPATCH_GLOSSARY#es-AR", SK: "CANAL_ASIGNADO#NARANJA", entity: "DispatchGlossary", ...SEED_META, status: "CANAL_ASIGNADO", channel: "NARANJA", text: "La aduana va a revisar la documentación.", gloss: "Customs will review the documents." },
    ]);
    const { reference } = stores.connector;
    expect((await reference.getTemplate("legajo_aprobado"))?.buttons).toEqual([]);
    expect((await reference.updateTemplate("legajo_aprobado", { status: "PENDING", metaTemplateId: "123" })).status).toBe("PENDING");
    expect((await reference.getDispatchGlossary("CANAL_ASIGNADO", "NARANJA"))?.gloss).toContain("Customs");
    expect(await reference.getDispatchGlossary("LIBERADO")).toBeUndefined();
  });
});

describe("memory connector: timers", () => {
  let stores: MemoryStores;
  const milestone = (timerId: string, dueAtSim: string) => ({ operationId: "op-4471", clockId: CLOCK, kind: "MILESTONE" as const, timerId, dueAtSim, status: "SCHEDULED" as const, payload: {} });

  beforeEach(async () => {
    stores = memoryStores();
    await seedDemoSlice(stores);
    const { timers } = stores.connector;
    await timers.createTimer(milestone("DOCS_REQUEST", "2026-10-15T10:00:00-03:00"));
    await timers.createTimer(milestone("FOLLOWUP", "2026-10-17T10:00:00-03:00"));
    await timers.createTimer({ ...milestone("x", "2026-10-15T22:00:00-03:00"), kind: "DEFERRED_SEND", timerId: "tm-01", reason: "CP-HOURS-SUPPLIER" });
  });

  it("finds what is due in a world, in simulated order, and the next event", async () => {
    const { timers } = stores.connector;
    expect((await timers.listDueTimers(CLOCK, "2026-10-15T22:00:00-03:00")).map((timer) => timer.timerId)).toEqual(["DOCS_REQUEST", "tm-01"]);
    expect((await timers.nextScheduledTimer(CLOCK))?.timerId).toBe("DOCS_REQUEST");
    expect((await timers.nextScheduledTimer(CLOCK, "2026-10-15T13:00:00.001Z"))?.timerId).toBe("tm-01");
    expect((await timers.listScheduledTimers(CLOCK, { from: "2026-10-15T00:00:00-03:00", until: "2026-10-15T22:00:00-03:00" })).map((timer) => timer.timerId)).toEqual(["DOCS_REQUEST"]);
    expect((await timers.getTimer("op-4471", "TIMER#MILESTONE#DOCS_REQUEST")).dueAtSim).toBe("2026-10-15T13:00:00.000Z");
    expect(await timers.listTimers("op-4471", { kind: "MILESTONE" })).toHaveLength(2);
    expect(await timers.listDueTimers("GLOBAL#firm-norte", "2026-12-31T00:00:00Z")).toEqual([]);
  });

  it("fires a SCHEDULED timer once, which takes it out of the world's due index", async () => {
    const { timers } = stores.connector;
    const key = "TIMER#MILESTONE#DOCS_REQUEST";
    await expect(timers.completeTimer({ operationId: "op-4471", timerKey: key, status: "FIRED", atSim: "2026-10-15T10:00:00-03:00" })).rejects.toMatchObject({ code: "VALIDATION" });
    const fired = await timers.completeTimer({ operationId: "op-4471", timerKey: key, status: "FIRED", firedBy: "CLOCK", atSim: "2026-10-15T10:00:00-03:00", expectedVersion: 1 });
    expect(fired).toMatchObject({ status: "FIRED", firedBy: "CLOCK", firedAtSim: "2026-10-15T13:00:00.000Z", version: 2 });
    expect((await stores.client.get("Operations", { PK: "OP#op-4471", SK: key }))?.clockDueKey).toBeUndefined();
    expect((await timers.listDueTimers(CLOCK, "2026-10-16T00:00:00-03:00")).map((timer) => timer.timerId)).toEqual(["tm-01"]);
    await expect(timers.completeTimer({ operationId: "op-4471", timerKey: key, status: "FIRED", firedBy: "SCHEDULER", atSim: "2026-10-15T10:00:00-03:00" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(timers.getTimer("op-4471", "TIMER#NOPE#x")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("reschedules with a version bump (a stale schedule's firing is a no-op) and keeps it on schedule bookkeeping", async () => {
    const { timers } = stores.connector;
    const key = "TIMER#MILESTONE#FOLLOWUP";
    const moved = await timers.rescheduleTimer({ operationId: "op-4471", timerKey: key, dueAtSim: "2026-10-15T10:00:00-03:00", reason: "ETA_CHANGE" });
    expect(moved).toMatchObject({ dueAtSim: "2026-10-15T13:00:00.000Z", version: 2 });
    const named = await timers.setScheduleName({ operationId: "op-4471", timerKey: key, scheduleName: "tm-d-op-4471-FOLLOWUP" });
    expect(named).toMatchObject({ scheduleName: "tm-d-op-4471-FOLLOWUP", version: 2 });
    await expect(timers.completeTimer({ operationId: "op-4471", timerKey: key, status: "FIRED", firedBy: "SCHEDULER", atSim: "2026-10-15T10:00:00-03:00", expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    const skipped = await timers.completeTimer({ operationId: "op-4471", timerKey: key, status: "SKIPPED", reason: "DOSSIER_COMPLETE", atSim: "2026-10-15T10:00:00-03:00", expectedVersion: 2 });
    expect(skipped.scheduleName).toBeUndefined();
    expect(skipped.firedAtSim).toBeUndefined();
    await expect(timers.createTimer(milestone("ARRIVAL_X", "2026-10-22T08:00:00-03:00"))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(timers.createTimer(milestone("ARRIVAL", "tomorrow"))).rejects.toThrow();
  });
});
