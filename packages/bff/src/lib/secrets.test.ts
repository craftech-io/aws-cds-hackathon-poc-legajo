import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSubkey } from "./crypto";

// Test-only values: the SST link is replaced by a plain object with the shape `Resource` has.
const linked: Record<string, unknown> = {};
vi.mock("sst", () => ({
  Resource: new Proxy(linked, {
    get(target, name) {
      if (typeof name === "string" && name in target) return target[name];
      throw new Error(`not linked: ${String(name)}`);
    },
  }),
}));

const { NOT_CONNECTED, parseSeedOverrides, resetSecretCache, secretValue, seedOverrides, subkey, whatsAppConnection } = await import("./secrets");

const MASTER = "test-master-key-test-master-key-00000000";

beforeEach(() => {
  for (const key of Object.keys(linked)) delete linked[key];
  resetSecretCache();
});

describe("secrets", () => {
  it("reads a linked secret and fails with UNAVAILABLE when it is not linked or empty", () => {
    linked.WabaId = { value: "waba-test" };
    expect(secretValue("WabaId")).toBe("waba-test");
    expect(() => secretValue("SeedOverrides")).toThrow(/not linked/);
    linked.WhatsAppPhoneNumberId = { value: "" };
    expect(() => secretValue("WhatsAppPhoneNumberId")).toThrow(/no value/);
  });

  it("hands out HKDF subkeys, never the master key, and refuses a short master key", () => {
    linked.SessionTokenKey = { value: MASTER };
    expect(Buffer.from(subkey("session"))).toEqual(Buffer.from(deriveSubkey(MASTER, "session")));
    expect(Buffer.from(subkey("thread"))).not.toEqual(Buffer.from(subkey("session")));
    resetSecretCache();
    linked.SessionTokenKey = { value: "short" };
    expect(() => subkey("session")).toThrow(/at least 32/);
  });

  it("reports live WhatsApp only once both secrets are connected", () => {
    linked.WabaId = { value: NOT_CONNECTED };
    linked.WhatsAppPhoneNumberId = { value: NOT_CONNECTED };
    expect(whatsAppConnection()).toBeUndefined();
    resetSecretCache();
    linked.WabaId = { value: "waba-test" };
    linked.WhatsAppPhoneNumberId = { value: "phone-number-id-test" };
    expect(whatsAppConnection()).toEqual({ wabaId: "waba-test", phoneNumberId: "phone-number-id-test" });
  });

  it("parses SeedOverrides with defaults and rejects an invalid value without echoing it", () => {
    linked.SeedOverrides = { value: "{}" };
    expect(seedOverrides()).toEqual({ demoRecipients: { emails: [], phones: [] }, firmMailboxCc: {}, importerPhones: {} });
    const parsed = parseSeedOverrides(JSON.stringify({ demoRecipients: { emails: ["Team@Corp.sim"], phones: ["+5491100000000"] }, importerPhones: { "imp-norpampa": "+5491100000001" }, operatorEmail: "ops@corp.sim" }));
    expect(parsed.demoRecipients.emails).toEqual(["team@corp.sim"]);
    expect(parsed.importerPhones).toEqual({ "imp-norpampa": "+5491100000001" });
    expect(() => parseSeedOverrides("{not json")).toThrow(/not valid JSON/);
    expect(() => parseSeedOverrides(JSON.stringify({ demoRecipients: { phones: ["5491100000000"] } }))).toThrow(/demoRecipients\.phones\.0/);
    expect(() => parseSeedOverrides(JSON.stringify({ extra: "secret-value" }))).toThrow(/invalid shape/);
    expect(() => parseSeedOverrides(JSON.stringify({ extra: "secret-value" }))).not.toThrow(/secret-value/);
  });
});
