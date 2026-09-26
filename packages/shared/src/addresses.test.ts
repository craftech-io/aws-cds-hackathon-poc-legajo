import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NOTICES_ADDRESS,
  SIM_MAIL_DOMAIN,
  STAGE_DOMAIN,
  ThreadTag,
  computeThreadTag,
  isReservedDomain,
  parseThreadAddress,
  threadAddress,
  threadTagMessage,
  verifyThreadTag,
} from "./addresses";

// A made-up key: the stage derives the real one from SessionTokenKey, the seed from a fixed constant.
const KEY = "test-thread-key";
const INPUT = { operationNumber: "4471", clockId: "GLOBAL#firm-delta", worldEpoch: 1 } as const;

// Independent reference: bit string of the HMAC, first 30 bits, 5 bits per Crockford character.
function referenceTag(message: string): string {
  const bits = [...createHmac("sha256", KEY).update(message).digest()].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return Array.from({ length: 6 }, (_, index) => alphabet[parseInt(bits.slice(index * 5, index * 5 + 5), 2)]).join("");
}

describe("stage domains", () => {
  it("are the domains of docs/architecture.md §1", () => {
    expect(STAGE_DOMAIN).toBe("legajo.demo.craftech.io");
    expect(SIM_MAIL_DOMAIN).toBe("sim.legajo.demo.craftech.io");
    expect(NOTICES_ADDRESS).toBe("avisos@legajo.demo.craftech.io");
  });
});

describe("reserved domains (RFC 2606, RFC 6761)", () => {
  it("rejects reserved TLDs and example domains, with or without subdomains", () => {
    for (const domain of ["shop.test", "x.example", "a.invalid", "localhost", "example.com", "mail.example.net", "EXAMPLE.ORG", "attacker.example.net."]) {
      expect(isReservedDomain(domain), domain).toBe(true);
    }
  });

  it("accepts our domains and look-alikes that are not reserved", () => {
    for (const domain of [SIM_MAIL_DOMAIN, STAGE_DOMAIN, "simulator.amazonses.com", "example.com.ar", "notexample.com", "testing.io"]) {
      expect(isReservedDomain(domain), domain).toBe(false);
    }
  });
});

describe("thread tag", () => {
  it("is the first 6 Crockford base32 characters of the HMAC of number | clock | epoch", async () => {
    expect(threadTagMessage(INPUT)).toBe("4471|GLOBAL#firm-delta|1");
    const tag = await computeThreadTag(KEY, INPUT);
    expect(tag).toBe(referenceTag("4471|GLOBAL#firm-delta|1"));
    expect(ThreadTag.safeParse(tag).success).toBe(true);
    expect(await computeThreadTag(new TextEncoder().encode(KEY), INPUT)).toBe(tag);
  });

  it("changes with the world, the epoch and the key", async () => {
    const tag = await computeThreadTag(KEY, INPUT);
    expect(await computeThreadTag(KEY, { ...INPUT, worldEpoch: 2 })).not.toBe(tag);
    expect(await computeThreadTag(KEY, { ...INPUT, clockId: "JUDGE#firm-judge-01" })).not.toBe(tag);
    expect(await computeThreadTag("other-key", INPUT)).not.toBe(tag);
  });

  it("rejects malformed inputs", () => {
    expect(() => threadTagMessage({ ...INPUT, worldEpoch: 0 })).toThrow(RangeError);
    expect(() => threadTagMessage({ ...INPUT, operationNumber: "44" })).toThrow();
    expect(() => threadTagMessage({ ...INPUT, clockId: "firm-delta" })).toThrow();
  });

  it("verifies only the exact tag", async () => {
    const tag = await computeThreadTag(KEY, INPUT);
    expect(await verifyThreadTag(KEY, INPUT, tag)).toBe(true);
    expect(await verifyThreadTag(KEY, { ...INPUT, worldEpoch: 2 }, tag)).toBe(false);
    expect(await verifyThreadTag(KEY, INPUT, tag.slice(0, 5))).toBe(false);
    expect(await verifyThreadTag(KEY, INPUT, `${tag}0`)).toBe(false);
  });
});

describe("thread address", () => {
  it("formats and parses op-<number>-<tag>@legajo.demo.craftech.io", () => {
    expect(threadAddress("4471", "k7p2q9")).toBe("op-4471-k7p2q9@legajo.demo.craftech.io");
    expect(parseThreadAddress("op-4471-k7p2q9@legajo.demo.craftech.io")).toEqual({ operationNumber: "4471", threadTag: "k7p2q9" });
    expect(() => threadAddress("4471", "K7P2Q9")).toThrow();
  });

  it("matches the domain exactly and nothing else", () => {
    for (const address of [
      "op-4471-k7p2q9@sim.legajo.demo.craftech.io",
      "op-4471-k7p2q9@legajo.demo.craftech.io.",
      "op-4471-k7p2q9@legajoXdemo.craftech.io",
      "OP-4471-K7P2Q9@legajo.demo.craftech.io",
      "op-4471-k7p2q@legajo.demo.craftech.io",
      "op-4471-k7p2qi@legajo.demo.craftech.io",
      "op-4471@legajo.demo.craftech.io",
      "x.op-4471-k7p2q9@legajo.demo.craftech.io",
      "Estudio <op-4471-k7p2q9@legajo.demo.craftech.io>",
    ]) {
      expect(parseThreadAddress(address), address).toBeUndefined();
    }
  });
});
