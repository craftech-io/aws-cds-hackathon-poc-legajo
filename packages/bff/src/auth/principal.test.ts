import { describe, expect, it } from "vitest";
import { memoryStores } from "../connector/testing";
import { AUTH_REASON } from "./errors";
import { IdTokenClaims } from "./jwt";
import { QA_PRINCIPAL, consoleRolesOf, guestFromClaims, guestOfPrincipal, isGuestFirm, isSignInFresh, principalFromClaims, qaPrincipal, resolveAccess, withBrokerRow } from "./principal";
import { brokerLookupOf, createBrokerDirectory } from "./staff";
import { seedBrokers } from "./testing";

const NOW = Math.floor(Date.parse("2026-10-14T13:30:00Z") / 1000);

function claims(overrides: Record<string, unknown> = {}): IdTokenClaims {
  return IdTokenClaims.parse({
    sub: "sub-1",
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1",
    aud: "client",
    token_use: "id",
    exp: NOW + 900,
    iat: NOW,
    auth_time: NOW,
    "cognito:username": "sub-1",
    "cognito:groups": ["ANALYST", "BROKER"],
    "custom:firmId": "firm-delta",
    ...overrides,
  });
}

const incomplete = expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE });

describe("principal", () => {
  it("takes firm and role from the token, the highest-precedence group when no role is stamped", () => {
    const principal = principalFromClaims(claims());
    expect(principal).toMatchObject({ firmId: "firm-delta", role: "BROKER", groups: ["BROKER", "ANALYST"], isGuest: false, authTime: NOW });
    expect(principal.brokerId).toBeUndefined();
    expect(principalFromClaims(claims({ "custom:role": "ANALYST" })).role).toBe("ANALYST");
    expect(consoleRolesOf(["Admins", "GUEST"])).toEqual(["GUEST"]);
  });

  it("marks guest accounts, only inside a guest firm", () => {
    expect(principalFromClaims(claims({ "cognito:groups": ["GUEST"], "custom:firmId": "firm-guest-03" })).isGuest).toBe(true);
    expect(principalFromClaims(claims({ "custom:isGuest": "true", "custom:firmId": "firm-guest-test" })).isGuest).toBe(true);
    expect(() => principalFromClaims(claims({ "cognito:groups": ["GUEST"] }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ "custom:isGuest": "true" }))).toThrowError(incomplete);
    expect(isGuestFirm("firm-guest-01")).toBe(true);
    expect(isGuestFirm("firm-delta")).toBe(false);
  });

  it("refuses a token without a firm or without a role", () => {
    expect(() => principalFromClaims(claims({ "custom:firmId": undefined }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ "custom:firmId": "Firm Delta" }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ "cognito:groups": [] }))).toThrowError(incomplete);
    expect(resolveAccess({ firmId: "firm-delta", role: "ROOT", groups: ["Admins"] })).toEqual({ ok: false, refusal: "NO_ROLE" });
  });

  it("lets a fresher broker row set the broker id and the role, and refuses an inactive broker", () => {
    const principal = principalFromClaims(claims());
    expect(withBrokerRow(principal, undefined)).toBe(principal);
    expect(withBrokerRow(principal, { brokerId: "brk-delta-diego", role: "ANALYST", active: true })).toMatchObject({ brokerId: "brk-delta-diego", role: "ANALYST", firmId: "firm-delta" });
    expect(() => withBrokerRow(principal, { brokerId: "brk-delta-diego", role: "BROKER", active: false })).toThrowError(expect.objectContaining({ reason: AUTH_REASON.BROKER_INACTIVE }));
    expect(() => withBrokerRow(principal, { brokerId: "brk-delta-diego", role: "GUEST", active: true })).toThrowError(incomplete);
  });

  it("keeps a guest a guest when its broker row says BROKER, inside the fence of its own guest firm", () => {
    const guest = principalFromClaims(claims({ "cognito:groups": ["GUEST"], "custom:isGuest": "true", "custom:firmId": "firm-guest-03" }));
    const row = { brokerId: "brk-guest-03", role: "BROKER", active: true } as const;
    expect(withBrokerRow(guest, row)).toMatchObject({ brokerId: "brk-guest-03", role: "BROKER", firmId: "firm-guest-03", isGuest: true });
    expect(() => withBrokerRow({ ...guest, firmId: "firm-delta" }, row)).toThrowError(incomplete);
    const broker = principalFromClaims(claims());
    expect(withBrokerRow(broker, { brokerId: "brk-delta-diego", role: "BROKER", active: true }).isGuest).toBe(false);
  });

  it("keeps the recent-login window at 15 minutes with 60 s of skew", () => {
    const at = (seconds: number) => new Date((NOW + seconds) * 1000);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60 + 1))).toBe(false);
    expect(isSignInFresh({ authTime: NOW }, at(-60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(-61))).toBe(false);
  });

  it("builds the QaDriver's principal on the server: firm-qa, BROKER or ANALYST, configurable sign-in", () => {
    const now = new Date(NOW * 1000);
    expect(qaPrincipal({ role: "BROKER", now })).toEqual({
      sub: QA_PRINCIPAL.sub,
      username: QA_PRINCIPAL.sub,
      firmId: "firm-qa",
      role: "BROKER",
      groups: ["BROKER"],
      isGuest: false,
      authTime: NOW,
      brokerId: "brk-qa-runner",
    });
    expect(qaPrincipal({ role: "ANALYST", now, authTime: new Date((NOW - 3600) * 1000) })).toMatchObject({ brokerId: "brk-qa-analyst", authTime: NOW - 3600 });
    expect(() => qaPrincipal({ role: "GUEST" as never, now })).toThrow();
  });
});

describe("broker directory", () => {
  it("reads a broker once per minute and per user", async () => {
    let reads = 0;
    let now = Date.parse("2026-10-14T13:30:00Z");
    const directory = createBrokerDirectory(
      {
        findBySub: async (_firm, sub) => {
          reads += 1;
          return sub === "sub-1" ? { brokerId: "brk-01", role: "BROKER", active: true } : undefined;
        },
      },
      () => new Date(now),
    );
    expect(await directory.find("firm-delta", "sub-1")).toEqual({ brokerId: "brk-01", role: "BROKER", active: true });
    await directory.find("firm-delta", "sub-1");
    expect(reads).toBe(1);
    now += 60_000;
    await directory.find("firm-delta", "sub-1");
    expect(reads).toBe(2);
    expect(await directory.find("firm-delta", "sub-2")).toBeUndefined();
  });

  it("matches a sub only against the broker rows of its own firm", async () => {
    const stores = memoryStores();
    await seedBrokers(stores, [
      { firmId: "firm-delta", brokerId: "brk-delta-diego", role: "BROKER", sub: "sub-diego" },
      { firmId: "firm-norte", brokerId: "brk-norte-pablo", role: "BROKER", sub: "sub-pablo", active: false },
    ]);
    const lookup = brokerLookupOf(stores.connector.firms);
    expect(await lookup.findBySub("firm-delta", "sub-diego")).toEqual({ brokerId: "brk-delta-diego", role: "BROKER", active: true });
    expect(await lookup.findBySub("firm-norte", "sub-diego")).toBeUndefined();
    expect(await lookup.findBySub("firm-norte", "sub-pablo")).toEqual({ brokerId: "brk-norte-pablo", role: "BROKER", active: false });
  });
});

describe("a guest's principal (ADR-0015 §4)", () => {
  const guest = (overrides: Record<string, unknown> = {}) => claims({ "cognito:groups": ["GUEST"], "custom:role": "GUEST", "custom:isGuest": "true", "custom:firmId": undefined, email: "ana@despachos-del-sur.com.ar", ...overrides });

  it("without a firm is no firm principal, but is a guest for the bootstrap procedures", () => {
    expect(() => principalFromClaims(guest())).toThrowError(incomplete);
    expect(guestFromClaims(guest())).toEqual({ sub: "sub-1", username: "sub-1", authTime: NOW, email: "ana@despachos-del-sur.com.ar" });
  });

  it("with its world: firm and lease from the token; the lease is never read for staff", () => {
    const principal = principalFromClaims(guest({ "custom:firmId": "firm-guest-41", "custom:worldLease": "lease-1" }));
    expect(principal).toMatchObject({ firmId: "firm-guest-41", isGuest: true, worldLease: "lease-1" });
    expect(guestOfPrincipal(principal)).toMatchObject({ firmId: "firm-guest-41", worldLease: "lease-1" });
    expect(principalFromClaims(claims({ "custom:worldLease": "lease-1" }))).not.toHaveProperty("worldLease");
    expect(guestOfPrincipal(principalFromClaims(claims()))).toBeUndefined();
  });

  it("staff and a guest token naming a firm that is not a guest firm are not bootstrap guests", () => {
    expect(guestFromClaims(claims())).toBeUndefined();
    expect(guestFromClaims(guest({ "custom:firmId": "firm-delta" }))).toBeUndefined();
  });
});
