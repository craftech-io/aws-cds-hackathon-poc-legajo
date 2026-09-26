// Secret-dependent primitives of the edge in one place: HKDF subkeys, HMACs, constant-time
// comparison, ULIDs, button nonces and upload-link tokens. Keys are always parameters (read once
// from `Resource` by lib/secrets.ts), so these functions stay pure and testable.
//
// `SessionTokenKey` is never used directly (docs/architecture.md §3): each purpose gets its own
// HKDF-SHA256 subkey with a fixed label, so a value leaked for one purpose (a simulated-envelope
// signature in a log, a phone hash) says nothing about the others. The thread tag of an operation
// address is computed by `computeThreadTag` of @legajo/shared with the `thread` subkey.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeEmail, normalizePhone } from "@legajo/shared";

export type SecretKey = string | Uint8Array;

/** Fixed labels of the subkeys (HKDF `info`); changing one invalidates every value derived with it. */
export const SUBKEY_PURPOSES = ["session", "phone-hash", "email-hash", "nonce", "sim-envelope", "thread", "runtime-session"] as const;
export type SubkeyPurpose = (typeof SUBKEY_PURPOSES)[number];

/** HKDF salt shared by every subkey of the app; public by design (RFC 5869 §3.1). */
export const SUBKEY_SALT = "aws-cds-hackathon-poc-legajo/subkeys/v1";
export const SUBKEY_BYTES = 32;

/** HKDF-SHA256 (RFC 5869): extract with `salt`, expand with `info` to `length` bytes. */
export function hkdfSha256(ikm: SecretKey, salt: SecretKey, info: SecretKey, length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > 255 * 32) throw new RangeError(`invalid HKDF length ${length}`);
  return new Uint8Array(hkdfSync("sha256", ikm, salt, info, length));
}

/** The subkey of one purpose. An empty master key is refused: every hash and signature would be public. */
export function deriveSubkey(master: SecretKey, purpose: SubkeyPurpose): Uint8Array {
  if (master.length === 0) throw new RangeError("the master key is empty");
  if (!SUBKEY_PURPOSES.includes(purpose)) throw new RangeError(`unknown subkey purpose "${String(purpose)}"`);
  return hkdfSha256(master, SUBKEY_SALT, purpose, SUBKEY_BYTES);
}

export function sha256Hex(message: string | Uint8Array): string {
  return createHash("sha256").update(message).digest("hex");
}

export function hmacSha256Hex(key: SecretKey, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

/** 43 characters: an HMAC-SHA256 in base64url, the signature segment of a session token. */
export function hmacSha256Base64Url(key: SecretKey, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64url");
}

// Constant-time comparison; a length mismatch is compared against itself so timing does not leak
// how many characters matched.
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * `phoneHash` of `Parties GSI1` and of `ADDR#<hash>` (key: `phone-hash` subkey): HMAC-SHA256 hex of
 * the E.164 number, the same value `addressHash("WHATSAPP", …)` of @legajo/shared gives.
 */
export function phoneHash(phoneHashKey: SecretKey, rawPhone: string): string {
  return hmacSha256Hex(phoneHashKey, normalizePhone(rawPhone));
}

/** `emailHash` of `Parties GSI2` and of `ADDR#<hash>` (key: `email-hash` subkey), lower-cased address. */
export function emailHash(emailHashKey: SecretKey, rawEmail: string): string {
  return hmacSha256Hex(emailHashKey, normalizeEmail(rawEmail));
}

export interface RuntimeSessionInput {
  readonly operationId: string;
  readonly clockId: string;
  readonly worldEpoch: number;
  readonly sessionEpoch: number;
}

export const RUNTIME_SESSION_ID_LENGTH = 48;

/**
 * `runtimeSessionId` of the Harness (docs/architecture.md §9.1): keyed hash of the operation, its
 * clock and both epochs with the `runtime-session` subkey, first 48 hex characters. A reset (new
 * world epoch) or a guardrail block (new session epoch) starts a clean session; no phone or email
 * ever enters the id.
 */
export function runtimeSessionId(runtimeSessionKey: SecretKey, input: RuntimeSessionInput): string {
  for (const [name, epoch] of [["worldEpoch", input.worldEpoch], ["sessionEpoch", input.sessionEpoch]] as const) {
    if (!Number.isInteger(epoch) || epoch < 0) throw new RangeError(`invalid ${name} ${epoch}`);
  }
  if (input.operationId === "" || input.clockId === "") throw new RangeError("operationId and clockId are required");
  const message = ["op", input.operationId, input.clockId, input.worldEpoch, input.sessionEpoch].join("|");
  return hmacSha256Hex(runtimeSessionKey, message).slice(0, RUNTIME_SESSION_ID_LENGTH);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out = (CROCKFORD[Number(remaining & 31n)] ?? "0") + out;
    remaining >>= 5n;
  }
  return out;
}

// ULID (48-bit millisecond timestamp + 80 random bits, Crockford base32, 26 chars): sortable ids
// for session ids, button nonces, turn ids and message ids without a dependency. The timestamp is
// real time by design: an id orders writes, it is not a business date.
export function ulid(nowMs: number = Date.now(), random: (size: number) => Uint8Array = randomBytes): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) throw new RangeError(`ulid time out of range: ${nowMs}`);
  const entropy = random(10);
  if (entropy.length !== 10) throw new RangeError("ulid needs 10 bytes of entropy");
  let randomPart = 0n;
  for (const byte of entropy) randomPart = (randomPart << 8n) | BigInt(byte);
  return encodeBase32(BigInt(nowMs), 10) + encodeBase32(randomPart, 16);
}

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Opaque button nonce: the model and the importer only ever see this, never a payload. */
export function newNonce(nowMs?: number): string {
  return ulid(nowMs);
}

/** Upload-link token: 32 random bytes, base64url (43 chars) (docs/architecture.md §11). */
export function newPublicToken(random: (size: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(32)).toString("base64url");
}

export const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
