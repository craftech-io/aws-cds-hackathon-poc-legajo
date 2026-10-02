// The two facts of a request that only CloudFront can vouch for (ADR-0015 §3.1 and §3.2): that it came
// through our distribution (`X-Origin-Verify`, compared in constant time as the first step of every
// route of `Bff` and `PublicWeb`) and who the viewer is (`CloudFront-Viewer-Address`, trusted only
// after that check). The viewer IP is never stored or logged in clear: rate limits key it as
// HMAC(K_rate, "v4|<a.b.c.d>") or HMAC(K_rate, "v6|<first 64 bits>"), so one host and one IPv6 /64 are
// one counter whatever the port or the address inside the prefix.
import { isIP } from "node:net";
import { type SecretKey, hmacSha256Hex, safeEqual } from "./crypto";

export const ORIGIN_VERIFY_HEADER = "x-origin-verify";
export const VIEWER_ADDRESS_HEADER = "cloudfront-viewer-address";

export type HeaderMap = Readonly<Record<string, string | undefined>> | undefined;

/** Case-insensitive header lookup (Function URLs lower-case names; tests and local servers may not). */
export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** True only when the request carries exactly the distribution's secret; absent or another value is false. */
export function isOriginVerified(headers: HeaderMap, expected: string): boolean {
  if (expected.length === 0) return false;
  const received = headerValue(headers, ORIGIN_VERIFY_HEADER);
  return received !== undefined && safeEqual(received, expected);
}

export interface ViewerIp {
  readonly family: 4 | 6;
  /** The address without port or zone, IPv4-mapped IPv6 already as IPv4. */
  readonly address: string;
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function hostOf(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close === -1 || trimmed[close + 1] !== ":" || !/^\d{1,5}$/.test(trimmed.slice(close + 2))) return undefined;
    return trimmed.slice(1, close);
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon <= 0 || !/^\d{1,5}$/.test(trimmed.slice(lastColon + 1))) return undefined;
  return trimmed.slice(0, lastColon);
}

/** `CloudFront-Viewer-Address` (`ip:port`, IPv6 with or without brackets) → the viewer's IP, or `undefined`. */
export function parseViewerAddress(value: string | undefined): ViewerIp | undefined {
  if (value === undefined || value.length > 128) return undefined;
  const host = hostOf(value)?.replace(/%[A-Za-z0-9._-]+$/, "");
  if (host === undefined) return undefined;
  const family = isIP(host);
  if (family === 4) return { family: 4, address: host };
  if (family !== 6) return undefined;
  const mapped = MAPPED_V4.exec(host)?.[1];
  if (mapped !== undefined && isIP(mapped) === 4) return { family: 4, address: mapped };
  return { family: 6, address: host.toLowerCase() };
}

/** The eight 16-bit groups of an IPv6 address, as four-digit hex; an embedded IPv4 tail becomes two groups. */
export function expandIpv6(address: string): string[] {
  let text = address.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1];
  if (tail !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) throw new RangeError("not an IPv6 address");
  return groups.map((group) => group.padStart(4, "0"));
}

/** What a rate limit counts: the IPv4 host (`/32`) or the IPv6 `/64` (ADR-0015 §3.2). */
export function viewerRateKey(ip: ViewerIp): string {
  return ip.family === 4 ? `v4|${ip.address}` : `v6|${expandIpv6(ip.address).slice(0, 4).join(":")}`;
}

/** HMAC of the aggregated viewer key with the `rate` subkey; the only form an IP is ever stored in. */
export function viewerIpHash(rateKey: SecretKey, ip: ViewerIp): string {
  return hmacSha256Hex(rateKey, viewerRateKey(ip));
}
