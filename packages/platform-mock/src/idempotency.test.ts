import { describe, expect, it } from "vitest";
import { ConnectorError } from "@legajo/shared";
import { platformPaths } from "./api";
import { PlatformEventId, newPlatformEventId, type PlatformFeedEvent } from "./events";
import { createPlatformApp } from "./app";
import { createRecordingPublisher } from "./publisher";
import { PlatformOperationItem } from "./schema";
import { createMemoryPlatformStore, parseStored, type PlatformStore } from "./store";
import { call, errorOf, operationItem, platformFixture, steppingClock } from "./testing";

const URL_ETA = platformPaths.eta("firm-delta", "4471");
const ADVANCE = { newEta: "2026-10-20T08:00:00-03:00", occurredAtSim: "2026-10-16T09:30:00-03:00" };
const KEY = { "idempotency-key": "qa-run-1/sc-10/7" };

describe("eventId", () => {
  it("gives every accepted change a new evt_<ULID> with the default generator", async () => {
    const publisher = createRecordingPublisher();
    const app = createPlatformApp({ store: createMemoryPlatformStore([operationItem()]), publisher, now: steppingClock(), log: () => undefined });
    for (const [index, newEta] of ["2026-10-20T08:00:00-03:00", "2026-10-21T08:00:00-03:00", "2026-10-23T08:00:00-03:00"].entries()) {
      const result = await call(app, "POST", URL_ETA, { body: { ...ADVANCE, newEta }, headers: { "idempotency-key": `k-${index}` } });
      expect(result.status).toBe(200);
    }
    const ids = publisher.events.map((event) => event.detail.eventId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(PlatformEventId.safeParse(id).success).toBe(true);
  });

  it("is unique across many ids of the same millisecond and sorts by time", () => {
    const ids = Array.from({ length: 2_000 }, () => newPlatformEventId(1_790_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.slice(0, 20)) expect(id).toMatch(/^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const earlier = newPlatformEventId(1_790_000_000_000);
    const later = newPlatformEventId(1_790_000_000_001);
    expect(earlier.slice(0, 14) < later.slice(0, 14)).toBe(true);
  });

  it("is deterministic with injected entropy and rejects a time out of range", () => {
    const zeros = (size: number) => new Uint8Array(size);
    expect(newPlatformEventId(0, zeros)).toBe(`evt_${"0".repeat(26)}`);
    expect(newPlatformEventId(2 ** 48 - 1, (size) => new Uint8Array(size).fill(255))).toBe(`evt_7${"Z".repeat(25)}`);
    expect(() => newPlatformEventId(-1)).toThrow(RangeError);
    expect(() => newPlatformEventId(2 ** 48)).toThrow(RangeError);
    expect(() => newPlatformEventId(1, () => new Uint8Array(4))).toThrow(RangeError);
  });
});

describe("[FL-064] retries with the same Idempotency-Key", () => {
  it("[FL-064] re-publishes the same eventId and changes the operation once", async () => {
    const { app, store, publisher } = platformFixture();
    const first = await call(app, "POST", URL_ETA, { body: ADVANCE, headers: KEY });
    const second = await call(app, "POST", URL_ETA, { body: ADVANCE, headers: KEY });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ replayed: true });
    const [a, b] = publisher.events;
    expect(a?.detail.eventId).toBeDefined();
    expect(b).toEqual(a);
    const meta = store.items().find((row) => row.entity === "PlatformOperation");
    expect(meta).toMatchObject({ version: 2 });
    expect(store.items().filter((row) => row.entity === "PlatformEvent")).toHaveLength(1);
  });

  it("answers 409 IDEMPOTENCY_KEY_REUSED when the key comes back with another request", async () => {
    const { app, publisher } = platformFixture();
    expect((await call(app, "POST", URL_ETA, { body: ADVANCE, headers: KEY })).status).toBe(200);

    const otherEta = await call(app, "POST", URL_ETA, { body: { ...ADVANCE, newEta: "2026-10-19T08:00:00-03:00" }, headers: KEY });
    const otherRoute = await call(app, "POST", platformPaths.customsStatus("firm-delta", "4471"), {
      body: { status: "OFICIALIZADO", occurredAtSim: ADVANCE.occurredAtSim },
      headers: KEY,
    });
    for (const result of [otherEta, otherRoute]) {
      expect(result.status).toBe(409);
      expect(errorOf(result)).toMatchObject({ code: "CONFLICT", reason: "IDEMPOTENCY_KEY_REUSED" });
    }
    expect(publisher.events).toHaveLength(1);
  });

  it("answers 503 with Retry-After when the bus fails after the commit, and the retry publishes the stored event", async () => {
    let failures = 1;
    const { app, store, publisher } = platformFixture({
      wrapPublisher: (recording) => ({
        async publish(event: PlatformFeedEvent) {
          if (failures > 0) {
            failures -= 1;
            throw new ConnectorError("UNAVAILABLE", "PutEvents: ServiceUnavailable");
          }
          await recording.publish(event);
        },
      }),
    });

    const failed = await call(app, "POST", URL_ETA, { body: ADVANCE, headers: KEY });
    expect(failed.status).toBe(503);
    expect(failed.headers["retry-after"]).toBe("1");
    expect(errorOf(failed).code).toBe("UNAVAILABLE");
    const stored = store.items().find((row) => row.entity === "PlatformEvent");
    expect(stored).toBeDefined();

    const retried = await call(app, "POST", URL_ETA, { body: ADVANCE, headers: KEY });
    expect(retried.status).toBe(200);
    expect(retried.json).toMatchObject({ replayed: true });
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]?.detail.eventId).toBe(stored?.entity === "PlatformEvent" ? stored.eventId : "");
  });

  it("answers the winner's event when a concurrent retry of the same request committed first", async () => {
    const winner = platformFixture();
    await call(winner.app, "POST", URL_ETA, { body: ADVANCE, headers: KEY });
    const winnerEvent = winner.store.items().find((row) => row.entity === "PlatformEvent");

    let lookups = 0;
    const { app, publisher } = platformFixture({
      wrapStore: (memory): PlatformStore => ({
        getOperation: (firmId, number) => memory.getOperation(firmId, number),
        async findEvent() {
          lookups += 1;
          return lookups === 1 || winnerEvent?.entity !== "PlatformEvent" ? undefined : winnerEvent;
        },
        async commit() {
          throw new ConnectorError("CONFLICT", "condition failed", "Platform");
        },
      }),
    });
    const result = await call(app, "POST", URL_ETA, { body: ADVANCE, headers: KEY });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ replayed: true });
    expect(publisher.events[0]).toEqual(winner.publisher.events[0]);
  });

  it("answers 409 VERSION_CONFLICT when another request changed the operation in between", async () => {
    const { app, publisher } = platformFixture({
      wrapStore: (memory): PlatformStore => ({
        getOperation: (firmId, number) => memory.getOperation(firmId, number),
        findEvent: async () => undefined,
        commit: async () => {
          throw new ConnectorError("CONFLICT", "condition failed", "Platform");
        },
      }),
    });
    const result = await call(app, "POST", URL_ETA, { body: ADVANCE, headers: KEY });
    expect(result.status).toBe(409);
    expect(errorOf(result).reason).toBe("VERSION_CONFLICT");
    expect(publisher.events).toHaveLength(0);
  });
});

describe("routing, dependency failures and logs", () => {
  it("answers 404 for unknown paths and 405 with Allow for a known path with another method", async () => {
    const { app } = platformFixture();
    for (const url of ["/", "/v1/operations", "/v1/operations/4471/", "/v2/health", "/v1/health/"]) {
      expect((await call(app, "GET", url)).status, url).toBe(404);
    }
    const wrong = await call(app, "DELETE", platformPaths.operation("firm-delta", "4471"));
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe("GET");
    expect((await call(app, "GET", URL_ETA)).headers.allow).toBe("POST");
  });

  it("answers 503 with Retry-After when the table is unavailable and 500 when a stored row is corrupt", async () => {
    const unavailable = platformFixture({
      wrapStore: (memory): PlatformStore => ({ ...memory, getOperation: async () => Promise.reject(new ConnectorError("THROTTLED", "throttled", "Platform")) }),
    });
    const down = await call(unavailable.app, "GET", platformPaths.operation("firm-delta", "4471"));
    expect(down.status).toBe(503);
    expect(down.headers["retry-after"]).toBe("1");

    const corrupt = platformFixture({
      wrapStore: (memory): PlatformStore => ({
        ...memory,
        getOperation: async () => parseStored(PlatformOperationItem, { ...operationItem(), PK: "POP#firm-other#4471" }, "operation"),
      }),
    });
    const broken = await call(corrupt.app, "GET", platformPaths.operation("firm-delta", "4471"));
    expect(broken.status).toBe(500);
    expect(errorOf(broken).code).toBe("INTERNAL");
  });

  it("writes one JSON log line per request with the correlation id and never a body value", async () => {
    const { app, logs } = platformFixture();
    const result = await call(app, "POST", URL_ETA, { body: ADVANCE, headers: { ...KEY, "x-correlation-id": "corr-0123456789" } });
    await call(app, "GET", platformPaths.operation("firm-norte", "4471"), { headers: { "x-correlation-id": "bad id with spaces" } });

    expect(result.headers["x-correlation-id"]).toBe("corr-0123456789");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ level: "info", correlationId: "corr-0123456789", method: "POST", route: "eta", status: 200, firmId: "firm-delta", operationNumber: "4471", replayed: false });
    expect(logs[0]?.eventId).toMatch(/^evt_/);
    expect(logs[1]).toMatchObject({ level: "warn", route: "operation", status: 404, firmId: "firm-norte" });
    expect(logs[1]?.correlationId).not.toBe("bad id with spaces");
    const serialized = JSON.stringify(logs);
    for (const value of ["2026-10-20T08:00:00", "2026-10-16T09:30", "Austral", "QBT-2026-0917", "imp-norpampa", KEY["idempotency-key"]]) {
      expect(serialized).not.toContain(value);
    }
  });
});
