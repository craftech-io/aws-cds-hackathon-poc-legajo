import { describe, expect, it } from "vitest";
import { Caller, PrincipalInput, SESSION_TOKEN_MAX_TTL_SECONDS, isSessionTokenExpired, principalKind, splitSessionToken } from "./caller";

const SIGNATURE = "a".repeat(43);
const TOKEN = `sess-01HZ.turn-01.1790000000.${SIGNATURE}`;

describe("caller", () => {
  it("accepts every direct-invocation kind of docs/tool-catalog.md", () => {
    expect(Caller.safeParse({ kind: "WORKER", firmId: "firm-delta", eventId: "evt_01J9ZQX" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "CHANNEL" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "SCHEDULER", firmId: "firm-delta" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "CONSOLE", firmId: "firm-delta", brokerId: "brk-delta-diego", role: "BROKER" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "QA", firmId: "firm-qa", brokerId: "brk-qa-analyst", role: "ANALYST" }).success).toBe(true);
  });

  it("rejects the Harness, unknown keys and ids of the wrong kind", () => {
    expect(Caller.safeParse({ kind: "HARNESS" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "WORKER", operationId: "op-4471" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", firmId: "imp-norpampa", role: "BROKER" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", firmId: "firm-delta", brokerId: "imp-norpampa", role: "BROKER" }).success).toBe(false);
  });

  it("console and QA callers are bound to a firm and a role; QA never acts as a judge", () => {
    expect(Caller.safeParse({ kind: "CONSOLE", role: "BROKER" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", firmId: "firm-delta" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "QA", firmId: "firm-qa" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "QA", firmId: "firm-qa", role: "JUDGE" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", firmId: "firm-judge-01", role: "JUDGE" }).success).toBe(true);
  });
});

describe("session token", () => {
  it("splits and checks expiry against an injected clock", () => {
    expect(splitSessionToken(TOKEN)).toEqual({ sessionId: "sess-01HZ", turnId: "turn-01", exp: 1790000000, signature: SIGNATURE });
    expect(isSessionTokenExpired(TOKEN, 1789999999_000)).toBe(false);
    expect(isSessionTokenExpired(TOKEN, 1790000000_000)).toBe(true);
    expect(SESSION_TOKEN_MAX_TTL_SECONDS).toBe(900);
  });

  it("rejects malformed tokens", () => {
    for (const token of ["not.a.token", `sess.turn.123.${"a".repeat(42)}`, `sess.turn.abc.${SIGNATURE}`, `se ss.turn.1.${SIGNATURE}`, `a.b.c.d.${SIGNATURE}`]) {
      expect(() => splitSessionToken(token), token).toThrow();
    }
  });
});

describe("principal input", () => {
  it("is exactly one of sessionToken or caller (LAM-CALLER)", () => {
    expect(principalKind(PrincipalInput.parse({ sessionToken: TOKEN, docVersionId: "dv-4471-PL-1" }))).toBe("SESSION");
    expect(principalKind(PrincipalInput.parse({ caller: { kind: "SCHEDULER" } }))).toBe("SCHEDULER");
    expect(PrincipalInput.safeParse({}).success).toBe(false);
    expect(PrincipalInput.safeParse({ sessionToken: TOKEN, caller: { kind: "WORKER" } }).success).toBe(false);
    expect(PrincipalInput.safeParse({ sessionToken: "forged" }).success).toBe(false);
  });
});
