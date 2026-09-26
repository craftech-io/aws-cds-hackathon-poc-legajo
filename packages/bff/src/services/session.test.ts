import { describe, expect, it } from "vitest";
import { SESSION_TOKEN_PATTERN, ToolError, isSessionTokenExpired, splitSessionToken } from "@legajo/shared";
import { memoryStores } from "../connector/testing";
import type { Turn } from "../domain/runtime";
import { deriveSubkey } from "../lib/crypto";
import { type SessionRecord, type SessionStore, issueSessionToken, newSessionId, resolveSession, verifySessionToken } from "./session";

const MASTER = "test-master-key-test-master-key-00000000";
const KEY = deriveSubkey(MASTER, "session");
const NOW = Date.parse("2026-11-02T15:00:00.000Z");
const SESSION_ID = "01JB8Z9Q2W3E4R5T6Y7U8I9O0P";
const TURN_ID = "01JB8Z9Q2W3E4R5T6Y7U8I9TRN";

const RECORD: SessionRecord = {
  sessionId: SESSION_ID,
  turnId: TURN_ID,
  operationId: "op-4471",
  firmId: "firm-delta",
  importerId: "imp-norpampa",
  supplierId: "sup-qingdao",
  trigger: "SUPPLIER_EMAIL",
  clockId: "GLOBAL#firm-delta",
  eventAtSim: "2026-10-16T01:10:00-03:00",
};

function store(overrides: { session?: unknown; turn?: Turn } = {}): SessionStore {
  return {
    getSession: async (sessionId) => ("session" in overrides ? overrides.session : sessionId === SESSION_ID ? { ...RECORD, pk: `SESSION#${sessionId}`, sk: "META", expiresAt: 1 } : undefined),
    getTurn: async () => overrides.turn,
  };
}

/** A store whose turns are the in-memory connector's: the turn is opened and closed by `RuntimePort`. */
async function connectorStore(): Promise<{ readonly store: SessionStore; readonly closeTurn: () => Promise<unknown> }> {
  const { runtime } = memoryStores().connector;
  await runtime.openTurn({ turnId: TURN_ID, sessionId: SESSION_ID, operationId: RECORD.operationId, clockId: RECORD.clockId, trigger: RECORD.trigger, openedAtReal: new Date(NOW).toISOString() });
  return {
    store: { getSession: store().getSession, getTurn: (turnId) => runtime.getTurn(turnId) },
    closeTurn: () => runtime.closeTurn(TURN_ID, new Date(NOW + 120_000).toISOString()),
  };
}

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("FORBIDDEN");
    return (error as ToolError).reason;
  }
}

describe("session tokens", () => {
  it("are <sessionId>.<turnId>.<exp>.<signature> and live 15 minutes of real time by default", () => {
    const { token, exp } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW);
    expect(token).toMatch(SESSION_TOKEN_PATTERN);
    expect(exp).toBe(NOW / 1000 + 900);
    expect(splitSessionToken(token)).toMatchObject({ sessionId: SESSION_ID, turnId: TURN_ID, exp });
    expect(isSessionTokenExpired(token, NOW + 899_000)).toBe(false);
    expect(isSessionTokenExpired(token, NOW + 900_000)).toBe(true);
  });

  it("never outlive 15 minutes and refuse malformed ids", () => {
    expect(() => issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID, ttlSeconds: 901 }, NOW)).toThrow(RangeError);
    expect(() => issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID, ttlSeconds: 0 }, NOW)).toThrow(RangeError);
    expect(() => issueSessionToken(KEY, { sessionId: "a.b", turnId: TURN_ID }, NOW)).toThrow();
    expect(newSessionId(NOW)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("verify with the session subkey only", () => {
    const { token } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID, ttlSeconds: 60 }, NOW);
    expect(verifySessionToken(KEY, token, NOW)).toMatchObject({ sessionId: SESSION_ID, turnId: TURN_ID });
    expect(() => verifySessionToken(deriveSubkey(MASTER, "nonce"), token, NOW)).toThrow(/signature/);
    expect(() => verifySessionToken(MASTER, token, NOW)).toThrow(/signature/);
  });

  it("reject tampering: another turn, a later expiry or a forged signature", () => {
    const { token } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW);
    const [sessionId, , exp, signature] = token.split(".");
    const otherTurn = [sessionId, "01JB8Z9Q2W3E4R5T6Y7U8I9XXX", exp, signature].join(".");
    const later = [sessionId, TURN_ID, String(Number(exp) + 3_600), signature].join(".");
    for (const forged of [otherTurn, later, `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`]) {
      expect(() => verifySessionToken(KEY, forged, NOW)).toThrow(ToolError);
    }
    expect(() => verifySessionToken(KEY, undefined, NOW)).toThrow(/malformed/);
    expect(() => verifySessionToken(KEY, `${token}.x`, NOW)).toThrow(/malformed/);
  });

  it("report SESSION_EXPIRED once the token expired and SESSION_INVALID for one signed too far ahead", async () => {
    const { token } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW);
    expect(await reason(resolveSession(KEY, token, store(), NOW + 900_000))).toBe("SESSION_EXPIRED");
    // A token issued by a container whose clock ran an hour ahead is refused, not trusted for an hour.
    const ahead = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW + 3_600_000).token;
    expect(await reason(resolveSession(KEY, ahead, store(), NOW))).toBe("SESSION_INVALID");
  });
});

describe("resolveSession", () => {
  const { token } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW);

  it("derives operation, firm, importer, supplier, clock and event time from the stored session", async () => {
    const session = await resolveSession(KEY, token, store(), NOW + 1_000);
    expect(session).toEqual({ ...RECORD, exp: NOW / 1000 + 900 });
    expect(session).not.toHaveProperty("pk");
  });

  it("accepts an open turn and refuses one closed through the connector before the token expires", async () => {
    const { store: live, closeTurn } = await connectorStore();
    await expect(resolveSession(KEY, token, live, NOW)).resolves.toMatchObject({ operationId: "op-4471" });
    await closeTurn();
    expect(await reason(resolveSession(KEY, token, live, NOW + 180_000))).toBe("SESSION_EXPIRED");
  });

  it("refuses a turn whose close instant is unreadable", async () => {
    const unreadable = { closedAtReal: "yesterday" } as unknown as Turn;
    expect(await reason(resolveSession(KEY, token, store({ turn: unreadable }), NOW))).toBe("SESSION_INVALID");
  });

  it("refuses a missing, malformed or foreign session record", async () => {
    expect(await reason(resolveSession(KEY, token, store({ session: undefined }), NOW))).toBe("SESSION_INVALID");
    expect(await reason(resolveSession(KEY, token, store({ session: { ...RECORD, operationId: "4471" } }), NOW))).toBe("SESSION_INVALID");
    expect(await reason(resolveSession(KEY, token, store({ session: { ...RECORD, turnId: "01JB8Z9Q2W3E4R5T6Y7U8I9XXX" } }), NOW))).toBe("SESSION_INVALID");
    expect(await reason(resolveSession(KEY, token, store({ session: { ...RECORD, sessionId: "01JB8Z9Q2W3E4R5T6Y7U8I9XXX" } }), NOW))).toBe("SESSION_INVALID");
  });
});
