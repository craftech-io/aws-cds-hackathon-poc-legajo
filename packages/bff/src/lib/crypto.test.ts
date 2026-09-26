import { describe, expect, it } from "vitest";
import { ThreadTag, addressHash, computeThreadTag } from "@legajo/shared";
import {
  PUBLIC_TOKEN_PATTERN,
  RUNTIME_SESSION_ID_LENGTH,
  SUBKEY_PURPOSES,
  ULID_PATTERN,
  deriveSubkey,
  emailHash,
  hkdfSha256,
  hmacSha256Base64Url,
  newNonce,
  newPublicToken,
  phoneHash,
  runtimeSessionId,
  safeEqual,
  ulid,
} from "./crypto";

// Test-only master key; the stage key is 32 random bytes in base64 (`sst.Secret` SessionTokenKey).
const MASTER = "test-master-key-test-master-key-00000000";
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("HKDF subkeys", () => {
  it("implements HKDF-SHA256 as RFC 5869 test case 1", () => {
    const ikm = Buffer.alloc(22, 0x0b);
    const salt = Buffer.from("000102030405060708090a0b0c", "hex");
    const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
    expect(hex(hkdfSha256(ikm, salt, info, 42))).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
    expect(() => hkdfSha256(ikm, salt, info, 0)).toThrow(RangeError);
  });

  it("derives one stable 32-byte subkey per fixed label, all different and none equal to the master", () => {
    const subkeys = SUBKEY_PURPOSES.map((purpose) => hex(deriveSubkey(MASTER, purpose)));
    expect(SUBKEY_PURPOSES).toEqual(["session", "phone-hash", "email-hash", "nonce", "sim-envelope", "thread", "runtime-session"]);
    expect(new Set(subkeys).size).toBe(SUBKEY_PURPOSES.length);
    for (const subkey of subkeys) expect(subkey).toMatch(/^[0-9a-f]{64}$/);
    expect(subkeys).not.toContain(Buffer.from(MASTER).toString("hex"));
    expect(hex(deriveSubkey(MASTER, "session"))).toBe(subkeys[0]);
    expect(hex(deriveSubkey(`${MASTER}x`, "session"))).not.toBe(subkeys[0]);
  });

  it("refuses an empty master key and an unknown purpose", () => {
    expect(() => deriveSubkey("", "session")).toThrow(RangeError);
    expect(() => deriveSubkey(MASTER, "other" as never)).toThrow(RangeError);
  });
});

describe("address hashes", () => {
  const phoneKey = deriveSubkey(MASTER, "phone-hash");
  const emailKey = deriveSubkey(MASTER, "email-hash");

  it("hash the normalized address with its own subkey, as the shared addressHash does", async () => {
    expect(phoneHash(phoneKey, "+54 9 11 5550-0101")).toBe(phoneHash(phoneKey, "+5491155500101"));
    expect(phoneHash(phoneKey, "+5491155500101")).toBe(await addressHash("WHATSAPP", "+5491155500101", phoneKey));
    expect(emailHash(emailKey, " Supplier-Qingdao@SIM.legajo.demo.craftech.io ")).toBe(emailHash(emailKey, "supplier-qingdao@sim.legajo.demo.craftech.io"));
    expect(emailHash(emailKey, "a@sim.legajo.demo.craftech.io")).toBe(await addressHash("EMAIL", "a@sim.legajo.demo.craftech.io", emailKey));
  });

  it("separate purposes: the same value under two subkeys gives two hashes", () => {
    expect(phoneHash(phoneKey, "+5491155500101")).not.toBe(phoneHash(emailKey, "+5491155500101"));
    expect(() => phoneHash(phoneKey, "12")).toThrow(RangeError);
  });

  it("the thread subkey feeds the shared thread tag: stable per world epoch, different after a reset", async () => {
    const threadKey = deriveSubkey(MASTER, "thread");
    const input = { operationNumber: "4471", clockId: "GLOBAL#firm-delta", worldEpoch: 1 };
    const tag = await computeThreadTag(threadKey, input);
    expect(ThreadTag.parse(tag)).toBe(tag);
    expect(await computeThreadTag(threadKey, input)).toBe(tag);
    expect(await computeThreadTag(threadKey, { ...input, worldEpoch: 2 })).not.toBe(tag);
    expect(await computeThreadTag(deriveSubkey(MASTER, "session"), input)).not.toBe(tag);
  });
});

describe("runtimeSessionId", () => {
  const key = deriveSubkey(MASTER, "runtime-session");
  const base = { operationId: "op-4471", clockId: "GLOBAL#firm-delta", worldEpoch: 1, sessionEpoch: 0 };

  it("is 48 characters the Harness accepts, with no phone or email in it", () => {
    const id = runtimeSessionId(key, base);
    expect(id).toHaveLength(RUNTIME_SESSION_ID_LENGTH);
    expect(id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/);
    expect(runtimeSessionId(key, base)).toBe(id);
  });

  it("changes with the world epoch, the session epoch, the clock and the key", () => {
    const id = runtimeSessionId(key, base);
    const variants = [
      runtimeSessionId(key, { ...base, worldEpoch: 2 }),
      runtimeSessionId(key, { ...base, sessionEpoch: 1 }),
      runtimeSessionId(key, { ...base, clockId: "JUDGE#firm-judge-01" }),
      runtimeSessionId(deriveSubkey(MASTER, "session"), base),
    ];
    expect(new Set([id, ...variants]).size).toBe(5);
    expect(() => runtimeSessionId(key, { ...base, worldEpoch: -1 })).toThrow(RangeError);
    expect(() => runtimeSessionId(key, { ...base, operationId: "" })).toThrow(RangeError);
  });
});

describe("tokens and ids", () => {
  it("generates sortable ULIDs, nonces and 32-byte upload tokens", () => {
    const zeros = (size: number) => new Uint8Array(size);
    expect(ulid(0, zeros)).toBe("0".repeat(26));
    expect(ulid(1_000, zeros) < ulid(2_000, zeros)).toBe(true);
    expect(newNonce()).toMatch(ULID_PATTERN);
    expect(newNonce()).not.toBe(newNonce());
    expect(newPublicToken()).toMatch(PUBLIC_TOKEN_PATTERN);
    expect(() => ulid(-1)).toThrow(RangeError);
  });

  it("signs in base64url and compares in constant time", () => {
    const key = deriveSubkey(MASTER, "session");
    expect(hmacSha256Base64Url(key, "a.b.1")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
