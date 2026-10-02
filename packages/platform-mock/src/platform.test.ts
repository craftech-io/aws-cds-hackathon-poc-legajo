import { describe, expect, it } from "vitest";
import { readDoc, tableRows } from "@legajo/shared/testing";
import { platformPaths } from "./api";
import { PLATFORM_ROUTES } from "./app";
import { FeedEventEnvelope, PlatformFeedEvent } from "./events";
import { PlatformOperation, platformPk } from "./schema";
import { call, errorOf, operation4471, operationItem, platformFixture } from "./testing";

const DELTA = "firm-delta";
const KEY = { "idempotency-key": "qa-run-1/sc-10/1" };
const INTEGRATIONS = readDoc("docs/architecture-integrations.md");

describe("[FL-005] GET /v1/operations/{operationNumber}?firm=<firmId>", () => {
  it("[FL-005] returns the master data of the requested firm's row, without table attributes", async () => {
    const { app } = platformFixture();
    const result = await call(app, "GET", platformPaths.operation(DELTA, "4471"));
    expect(result.status).toBe(200);
    expect(result.json).toEqual(PlatformOperation.parse(operation4471()));
    expect(result.json).toMatchObject({
      vessel: "Austral Aurora",
      carrier: "Austral Line",
      regime: "Importación para consumo",
      eta: "2026-10-22T08:00:00-03:00",
      invoiceNumber: "QBT-2026-0917",
      incoterm: "FOB",
      documents: { COMMERCIAL_INVOICE: "VALID", PACKING_LIST: "MISSING", CERTIFICATE_OF_ORIGIN: "MISSING" },
      customs: { status: "NONE" },
    });
    for (const attribute of ["PK", "SK", "entity", "version", "createdAt", "world", "expiresAt"]) expect(result.json).not.toHaveProperty(attribute);
  });

  it("[FL-005] answers 404 for the same number in another firm and serves each guest firm its own row", async () => {
    const guest = operationItem({ firmId: "firm-guest-01", eta: "2026-10-20T08:00:00-03:00" }, { clockId: "GUEST#firm-guest-01", world: "guest" });
    const { app } = platformFixture({ items: [operationItem(), guest] });

    const other = await call(app, "GET", platformPaths.operation("firm-norte", "4471"));
    expect(other.status).toBe(404);
    expect(errorOf(other).code).toBe("NOT_FOUND");

    const delta = await call(app, "GET", platformPaths.operation(DELTA, "4471"));
    const own = await call(app, "GET", platformPaths.operation("firm-guest-01", "4471"));
    expect(delta.json).toMatchObject({ firmId: DELTA, eta: "2026-10-22T08:00:00-03:00" });
    expect(own.json).toMatchObject({ firmId: "firm-guest-01", eta: "2026-10-20T08:00:00-03:00" });
  });

  it("[FL-005] answers 404 for a number the firm does not have", async () => {
    const { app } = platformFixture();
    const result = await call(app, "GET", platformPaths.operation(DELTA, "4472"));
    expect(result.status).toBe(404);
  });

  it("rejects a missing, repeated or malformed firm and a malformed number with 400", async () => {
    const { app } = platformFixture();
    for (const url of [
      "/v1/operations/4471",
      "/v1/operations/4471?firm=firm-delta&firm=firm-norte",
      "/v1/operations/4471?firm=delta",
      "/v1/operations/44710?firm=firm-delta",
      "/v1/operations/op-4471?firm=firm-delta",
    ]) {
      const result = await call(app, "GET", url);
      expect(result.status, url).toBe(400);
      expect(errorOf(result).code, url).toBe("INVALID_REQUEST");
    }
  });
});

describe("GET /v1/health", () => {
  it("answers 200 ok", async () => {
    const { app } = platformFixture();
    const result = await call(app, "GET", platformPaths.health());
    expect(result).toMatchObject({ status: 200, json: { status: "ok" } });
  });
});

describe("routes of docs/architecture-integrations.md §6", () => {
  it("serves every documented route with its method and exposes no other", () => {
    const documented = tableRows(INTEGRATIONS, "| Ruta | Uso |").map(([cell = ""]) => {
      const [method = "", path = ""] = cell.replaceAll("`", "").split(" ");
      return { method, path: path.split("?")[0]?.replace("{operationNumber}", "4471") ?? "" };
    });
    expect(documented).toHaveLength(PLATFORM_ROUTES.length);
    for (const { method, path } of documented) {
      expect(
        PLATFORM_ROUTES.some((route) => route.method === method && route.pattern.test(path)),
        `${method} ${path}`,
      ).toBe(true);
    }
  });

  it("parses the two event examples with the published and the bus-envelope schemas", () => {
    const start = INTEGRATIONS.indexOf("Eventos en el bus `Feeds`");
    const open = INTEGRATIONS.indexOf("```json", start);
    const block = INTEGRATIONS.slice(open + "```json".length, INTEGRATIONS.indexOf("```", open + 7));
    const examples = block
      .split(/\n(?=\{ "Source")/)
      .map((text) => text.trim())
      .filter((text) => text !== "")
      .map((text) => JSON.parse(text.replace(/"evt_01…"/, '"evt_01K6ABCDEFGHJKMNPQRSTVWXYZ"')) as { Source: string; DetailType: string; Detail: unknown });
    expect(examples.map((example) => example.DetailType)).toEqual(["CarrierEtaChanged", "CustomsStatusChanged"]);
    for (const example of examples) {
      expect(() => PlatformFeedEvent.parse({ source: example.Source, detailType: example.DetailType, detail: example.Detail })).not.toThrow();
      const envelope = { version: "0", id: "11111111-2222-3333-4444-555555555555", source: example.Source, "detail-type": example.DetailType, account: "000000000000", region: "us-east-1", detail: example.Detail };
      expect(FeedEventEnvelope.parse(envelope)["detail-type"]).toBe(example.DetailType);
    }
  });
});

describe("[FL-061] POST /v1/operations/{operationNumber}/eta", () => {
  const advance = { newEta: "2026-10-20T08:00:00-03:00", occurredAtSim: "2026-10-16T09:30:00-03:00" };

  it("[FL-061] moves the ETA, logs the event and publishes CarrierEtaChanged to the bus", async () => {
    const guest = operationItem({ firmId: "firm-guest-03" }, { clockId: "GUEST#firm-guest-03", world: "guest", expiresAt: 1_893_456_000 });
    const { app, store, publisher } = platformFixture({ items: [guest] });

    const result = await call(app, "POST", platformPaths.eta("firm-guest-03", "4471"), { body: advance, headers: KEY });

    expect(result.status).toBe(200);
    const [published] = publisher.events;
    expect(publisher.events).toHaveLength(1);
    expect(result.json).toEqual({ event: published, replayed: false });
    expect(published).toEqual({
      source: "mock.platform.carrier",
      detailType: "CarrierEtaChanged",
      detail: {
        eventId: published?.detail.eventId,
        firmId: "firm-guest-03",
        operationNumber: "4471",
        vessel: "Austral Aurora",
        previousEta: "2026-10-22T08:00:00-03:00",
        newEta: "2026-10-20T08:00:00-03:00",
        reason: "SCHEDULE_ADVANCED",
        occurredAtSim: "2026-10-16T09:30:00-03:00",
      },
    });

    const after = await call(app, "GET", platformPaths.operation("firm-guest-03", "4471"));
    expect(after.json).toMatchObject({ eta: "2026-10-20T08:00:00-03:00" });
    const rows = store.items();
    expect(rows.map((row) => row.entity).sort()).toEqual(["PlatformEvent", "PlatformOperation"]);
    expect(rows.find((row) => row.entity === "PlatformOperation")).toMatchObject({ version: 2, eta: "2026-10-20T08:00:00-03:00" });
    // The event row inherits the world attributes, so the world's reset and TTL reach it.
    expect(rows.find((row) => row.entity === "PlatformEvent")).toMatchObject({
      PK: platformPk("firm-guest-03", "4471"),
      eventId: published?.detail.eventId,
      idempotencyKey: KEY["idempotency-key"],
      clockId: "GUEST#firm-guest-03",
      world: "guest",
      expiresAt: 1_893_456_000,
    });
  });

  it("[FL-062] a later ETA is published as SCHEDULE_DELAYED", async () => {
    const { app, publisher } = platformFixture();
    const result = await call(app, "POST", platformPaths.eta(DELTA, "4471"), {
      body: { newEta: "2026-10-26T08:00:00-03:00", occurredAtSim: "2026-10-16T09:30:00-03:00" },
      headers: KEY,
    });
    expect(result.status).toBe(200);
    expect(publisher.events[0]?.detail).toMatchObject({ previousEta: "2026-10-22T08:00:00-03:00", newEta: "2026-10-26T08:00:00-03:00", reason: "SCHEDULE_DELAYED" });
  });

  it("refuses the current ETA, also written in another zone, with 409 ETA_UNCHANGED and changes nothing", async () => {
    const { app, store, publisher } = platformFixture();
    const result = await call(app, "POST", platformPaths.eta(DELTA, "4471"), {
      body: { newEta: "2026-10-22T11:00:00Z", occurredAtSim: "2026-10-16T09:30:00-03:00" },
      headers: KEY,
    });
    expect(result.status).toBe(409);
    expect(errorOf(result)).toMatchObject({ code: "CONFLICT", reason: "ETA_UNCHANGED" });
    expect(publisher.events).toHaveLength(0);
    expect(store.items()).toEqual([operationItem()]);
  });

  it("answers 404 for an operation the firm does not have, before anything changes", async () => {
    const { app, publisher } = platformFixture();
    const result = await call(app, "POST", platformPaths.eta("firm-norte", "4471"), { body: advance, headers: KEY });
    expect(result.status).toBe(404);
    expect(publisher.events).toHaveLength(0);
  });

  it("needs an Idempotency-Key and a strict JSON body", async () => {
    const { app, publisher } = platformFixture();
    const url = platformPaths.eta(DELTA, "4471");
    const cases: Array<[string, { body?: unknown; headers?: Record<string, string> }, number]> = [
      ["no key", { body: advance }, 400],
      ["key with spaces", { body: advance, headers: { "idempotency-key": "a b" } }, 400],
      ["unknown field", { body: { ...advance, reason: "SCHEDULE_ADVANCED" }, headers: KEY }, 400],
      ["ETA without zone", { body: { ...advance, newEta: "2026-10-20T08:00:00" }, headers: KEY }, 400],
      ["date only", { body: { ...advance, newEta: "2026-10-20" }, headers: KEY }, 400],
      ["missing occurredAtSim", { body: { newEta: advance.newEta }, headers: KEY }, 400],
      ["not JSON", { body: "{newEta:", headers: KEY }, 400],
      ["empty body", { headers: KEY }, 400],
      ["oversized body", { body: { ...advance, padding: "x".repeat(9_000) }, headers: KEY }, 413],
    ];
    for (const [name, init, status] of cases) {
      const result = await call(app, "POST", url, init);
      expect(result.status, name).toBe(status);
    }
    expect(publisher.events).toHaveLength(0);
  });
});

describe("[FL-077] POST /v1/operations/{operationNumber}/customs-status", () => {
  const post = (app: ReturnType<typeof platformFixture>["app"], key: string, body: unknown) =>
    call(app, "POST", platformPaths.customsStatus(DELTA, "4471"), { body, headers: { "idempotency-key": key } });

  it("[FL-077] publishes OFICIALIZADO, CANAL_ASIGNADO NARANJA and LIBERADO, each with its own eventId", async () => {
    const { app, publisher } = platformFixture();
    const steps = [
      { status: "OFICIALIZADO", occurredAtSim: "2026-10-20T15:00:00-03:00" },
      { status: "CANAL_ASIGNADO", channel: "NARANJA", occurredAtSim: "2026-10-21T11:00:00-03:00" },
      { status: "LIBERADO", occurredAtSim: "2026-10-22T16:00:00-03:00" },
    ];
    for (const [index, step] of steps.entries()) expect((await post(app, `customs-${index}`, step)).status).toBe(200);

    expect(publisher.events.map((event) => [event.source, event.detailType])).toEqual(Array(3).fill(["mock.platform.customs", "CustomsStatusChanged"]));
    expect(publisher.events.map((event) => event.detail)).toEqual(
      steps.map((step, index) => ({ eventId: publisher.events[index]?.detail.eventId, firmId: DELTA, operationNumber: "4471", ...step })),
    );
    expect(new Set(publisher.events.map((event) => event.detail.eventId)).size).toBe(3);
    const after = await call(app, "GET", platformPaths.operation(DELTA, "4471"));
    expect(after.json).toMatchObject({ customs: { status: "LIBERADO", channel: "NARANJA" } });
  });

  it("needs the channel with CANAL_ASIGNADO and only with it, and never accepts NONE", async () => {
    const { app, publisher } = platformFixture();
    const at = "2026-10-21T11:00:00-03:00";
    for (const body of [
      { status: "CANAL_ASIGNADO", occurredAtSim: at },
      { status: "OFICIALIZADO", channel: "VERDE", occurredAtSim: at },
      { status: "NONE", occurredAtSim: at },
      { status: "CANAL_ASIGNADO", channel: "AZUL", occurredAtSim: at },
    ]) {
      expect((await post(app, "k", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(publisher.events).toHaveLength(0);
  });

  it("refuses to repeat or go back with 409 STATUS_NOT_FORWARD", async () => {
    const { app, publisher } = platformFixture();
    const at = "2026-10-21T11:00:00-03:00";
    expect((await post(app, "a", { status: "CANAL_ASIGNADO", channel: "VERDE", occurredAtSim: at })).status).toBe(200);
    for (const [key, body] of [
      ["b", { status: "CANAL_ASIGNADO", channel: "ROJO", occurredAtSim: at }],
      ["c", { status: "OFICIALIZADO", occurredAtSim: at }],
    ] as const) {
      const result = await post(app, key, body);
      expect(result.status).toBe(409);
      expect(errorOf(result).reason).toBe("STATUS_NOT_FORWARD");
    }
    expect(publisher.events).toHaveLength(1);
  });
});
