import { describe, expect, it } from "vitest";
import { deriveSubkey } from "./crypto";
import { ORIGIN_VERIFY_HEADER, expandIpv6, isOriginVerified, parseViewerAddress, viewerIpHash, viewerRateKey } from "./viewer-ip";

const RATE = deriveSubkey("test-master-key-test-master-key-00000000", "rate");
const hashOf = (header: string): string => {
  const ip = parseViewerAddress(header);
  if (ip === undefined) throw new Error(`unparsed ${header}`);
  return viewerIpHash(RATE, ip);
};

describe("[FL-112] viewer IP of CloudFront-Viewer-Address (ADR-0015 §3.2)", () => {
  it("IPv4 ip:port, with another port the same key", () => {
    expect(parseViewerAddress("198.51.100.10:46532")).toEqual({ family: 4, address: "198.51.100.10" });
    expect(hashOf("198.51.100.10:46532")).toBe(hashOf("198.51.100.10:1024"));
    expect(viewerRateKey({ family: 4, address: "198.51.100.10" })).toBe("v4|198.51.100.10");
    expect(hashOf("198.51.100.10:46532")).not.toBe(hashOf("198.51.100.11:46532"));
  });

  it("IPv6 in both forms, split by the last colon or by the brackets", () => {
    expect(parseViewerAddress("2001:db8::1:46532")).toEqual({ family: 6, address: "2001:db8::1" });
    expect(parseViewerAddress("[2001:db8::1]:46532")).toEqual({ family: 6, address: "2001:db8::1" });
    expect(hashOf("2001:db8::1:46532")).toBe(hashOf("[2001:db8::1]:443"));
  });

  it("two addresses of one /64 share a key; different /64 do not", () => {
    expect(hashOf("[2001:db8:0:1::a]:1")).toBe(hashOf("[2001:db8:0:1:ffff:ffff:ffff:ffff]:2"));
    expect(hashOf("[2001:db8:0:1::a]:1")).not.toBe(hashOf("[2001:db8:0:2::a]:1"));
    expect(viewerRateKey({ family: 6, address: "2001:db8::1" })).toBe("v6|2001:0db8:0000:0000");
    expect(expandIpv6("::1")).toEqual(["0000", "0000", "0000", "0000", "0000", "0000", "0000", "0001"]);
    expect(expandIpv6("64:ff9b::192.0.2.33").slice(6)).toEqual(["c000", "0221"]);
  });

  it("an IPv4-mapped IPv6 address counts as the IPv4", () => {
    expect(parseViewerAddress("[::ffff:198.51.100.10]:46532")).toEqual({ family: 4, address: "198.51.100.10" });
    expect(hashOf("[::ffff:198.51.100.10]:46532")).toBe(hashOf("198.51.100.10:1"));
  });

  it("a missing, empty or garbage header is refused", () => {
    for (const header of [undefined, "", "198.51.100.10", "not-an-ip:443", "[2001:db8::1]", "[2001:db8::1]x:1", "999.1.1.1:80", "1.2.3.4:abc", `${"a".repeat(200)}:1`]) {
      expect(parseViewerAddress(header), String(header)).toBeUndefined();
    }
  });
});

describe("[FL-113] X-Origin-Verify", () => {
  it("passes only with exactly the distribution's value, whatever the header's case", () => {
    expect(isOriginVerified({ [ORIGIN_VERIFY_HEADER]: "s3cr3t-value" }, "s3cr3t-value")).toBe(true);
    expect(isOriginVerified({ "X-Origin-Verify": "s3cr3t-value" }, "s3cr3t-value")).toBe(true);
    expect(isOriginVerified({ [ORIGIN_VERIFY_HEADER]: "s3cr3t-valuE" }, "s3cr3t-value")).toBe(false);
    expect(isOriginVerified({ [ORIGIN_VERIFY_HEADER]: "s3cr3t" }, "s3cr3t-value")).toBe(false);
    expect(isOriginVerified({}, "s3cr3t-value")).toBe(false);
    expect(isOriginVerified(undefined, "s3cr3t-value")).toBe(false);
    expect(isOriginVerified({ [ORIGIN_VERIFY_HEADER]: "" }, "")).toBe(false);
  });
});
